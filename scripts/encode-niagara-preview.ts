import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { NiagaraPreviewRunManifest } from "../packages/niagara/src/schema.ts";
import {
	selectNiagaraPresentation,
	selectNiagaraVariantPresentation
} from "../packages/niagara/src/presentation.ts";

const { values } = parseArgs({
	options: {
		manifest: { type: "string" },
		reference: { type: "string" },
		ffmpeg: { type: "string" },
		output: { type: "string" }
	}
});
if (!values.manifest || !values.ffmpeg || !values.output) {
	throw new Error(
		"Usage: --manifest <manifest.json> --ffmpeg <executable> --output <new-directory>"
	);
}
const manifestPath = resolve(values.manifest);
const encoder = resolve(values.ffmpeg);
const output = resolve(values.output);
const root = dirname(manifestPath);
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const manifestBytes = await readFile(manifestPath);
const manifest = Schema.decodeUnknownSync(NiagaraPreviewRunManifest)(
	JSON.parse(manifestBytes.toString("utf8"))
);
if (manifest.effectiveSettings.width % 2 !== 0 || manifest.effectiveSettings.height % 2 !== 0) {
	throw new Error("H.264/yuv420p requires even capture width and height.");
}
if (
	manifest.artifacts.length !== manifest.effectiveSettings.frameCount ||
	manifest.artifacts.some(
		(frame, index) =>
			frame.index !== index ||
			frame.relativePath !== `frames/frame_${String(index).padStart(4, "0")}.png` ||
			frame.width !== manifest.effectiveSettings.width ||
			frame.height !== manifest.effectiveSettings.height
	)
) {
	throw new Error(
		"Capture frames must form the complete ordered sequence at the effective dimensions."
	);
}
const referenceBytes = values.reference ? await readFile(resolve(values.reference)) : undefined;
const reference = referenceBytes
	? Schema.decodeUnknownSync(NiagaraPreviewRunManifest)(
			JSON.parse(referenceBytes.toString("utf8"))
		)
	: undefined;
const selection = reference
	? selectNiagaraVariantPresentation(manifest, reference)
	: selectNiagaraPresentation(manifest);
if (
	await stat(output).then(
		() => true,
		() => false
	)
)
	throw new Error("Output already exists.");
for (const frame of manifest.artifacts) {
	const bytes = await readFile(join(root, frame.relativePath));
	if (bytes.length !== frame.bytes || hash(bytes) !== frame.sha256)
		throw new Error(`Frame integrity failed: ${frame.relativePath}`);
}
const run = (command: string, args: string[]) => {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		windowsHide: true,
		timeout: 120_000,
		maxBuffer: 8 * 1024 * 1024
	});
	if (result.error || result.status !== 0)
		throw new Error(`${command} failed: ${result.error ?? result.stderr}`);
	return result.stdout;
};
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(dirname(output), ".niagara-video-"));
try {
	const video = join(staging, "preview.mp4");
	const settings = manifest.effectiveSettings;
	const fps = String(selection.playbackFramesPerSecond);
	const input = [
		"-framerate",
		fps,
		"-start_number",
		String(selection.startFrame),
		"-i",
		join(root, "frames/frame_%04d.png")
	];
	const composite =
		manifest.alphaPolicy === "opaque_scene_v1"
			? [...input, "-vf", "format=yuv420p"]
			: [
					"-f",
					"lavfi",
					"-i",
					`color=c=0x181818:s=${settings.width}x${settings.height}:r=${fps}`,
					...input,
					"-filter_complex",
					"[0:v][1:v]overlay=shortest=1:format=auto,format=yuv420p[v]",
					"-map",
					"[v]"
				];
	const args = [
		"-nostdin",
		"-n",
		"-hide_banner",
		"-loglevel",
		"warning",
		...composite,
		"-frames:v",
		String(selection.frameCount),
		"-an",
		"-c:v",
		"libx264",
		"-preset",
		"medium",
		"-crf",
		"18",
		"-movflags",
		"+faststart",
		video
	];
	run(encoder, args);
	const probeText = run(
		join(dirname(encoder), process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
		["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", video]
	);
	const probe = Schema.decodeUnknownSync(
		Schema.Struct({
			streams: Schema.Array(
				Schema.Struct({
					codec_name: Schema.String,
					pix_fmt: Schema.String,
					width: Schema.Number,
					height: Schema.Number,
					nb_read_frames: Schema.String
				})
			)
		})
	)(JSON.parse(probeText));
	const stream = probe.streams[0];
	if (
		!stream ||
		stream.codec_name !== "h264" ||
		stream.pix_fmt !== "yuv420p" ||
		stream.width !== settings.width ||
		stream.height !== settings.height ||
		Number(stream.nb_read_frames) !== selection.frameCount
	) {
		throw new Error("Encoded video does not match selected capture frames.");
	}
	const poster = manifest.artifacts[selection.posterFrame];
	if (!poster) throw new Error("Selected poster is absent.");
	await copyFile(join(root, poster.relativePath), join(staging, "poster.png"));
	await writeFile(join(staging, "ffprobe.json"), probeText);
	await writeFile(
		join(staging, "presentation.json"),
		JSON.stringify(
			{
				...selection,
				referenceManifestSha256: referenceBytes ? hash(referenceBytes) : undefined,
				runId: manifest.runId,
				sourceManifest: manifestPath,
				sourceManifestSha256: hash(manifestBytes),
				encoderVersion: run(encoder, ["-version"]).split(/\r?\n/u)[0],
				encoderSha256: hash(await readFile(encoder)),
				arguments: args,
				videoSha256: hash(await readFile(video)),
				posterSha256: poster.sha256,
				alphaHandling:
					manifest.alphaPolicy === "opaque_scene_v1"
						? "Unreal scene composite"
						: "Straight alpha over #181818",
				createdAtUtc: new Date().toISOString()
			},
			null,
			2
		)
	);
	await rename(staging, output);
	console.log(JSON.stringify({ output, ...selection }));
} finally {
	await rm(staging, { recursive: true, force: true });
}
