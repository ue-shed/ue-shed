import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
	throw new Error(`Data Authoring target verification failed: ${message}`);
}

function option(name) {
	const prefix = `--${name}=`;
	return process.argv
		.slice(2)
		.find((argument) => argument.startsWith(prefix))
		?.slice(prefix.length);
}

async function filesUnder(path) {
	const entry = await stat(path);
	if (!entry.isDirectory()) return [path];
	const files = [];
	for (const child of await readdir(path, { withFileTypes: true })) {
		if (["dist", "node_modules"].includes(child.name)) continue;
		files.push(...(await filesUnder(join(path, child.name))));
	}
	return files;
}

const expectedAccent = option("expected-accent");
if (!expectedAccent || !/^#[0-9a-f]{6}$/i.test(expectedAccent)) {
	fail("pass --expected-accent=#rrggbb to prove adopter-owned theme divergence");
}

const manifest = JSON.parse(
	await readFile(join(targetRoot, ".ue-shed", "data-authoring", "adoption.manifest.json"), "utf8")
);
if (manifest.schemaVersion !== 2 || manifest.slice !== "data-authoring") {
	fail("the manifest snapshot has an unsupported identity or version");
}

const declaredEntries = [...manifest.copy.kernel, ...manifest.copy.owned];
if (declaredEntries.some((entry) => /(?:^|[\\/]).*\.test\.[^.]+$/.test(entry))) {
	fail("the production copy closure contains source-side tests");
}
for (const entry of declaredEntries) {
	try {
		await stat(join(targetRoot, entry));
	} catch {
		fail(`missing declared entry ${entry}`);
	}
}

const provenance = JSON.parse(await readFile(join(targetRoot, manifest.provenance.target), "utf8"));
if (
	provenance.schemaVersion !== 1 ||
	provenance.slice !== manifest.slice ||
	provenance.source?.repository !== manifest.provenance.repository ||
	!/^[0-9a-f]{40}$/.test(provenance.source?.commit ?? "") ||
	JSON.stringify(provenance.ownership?.kernel) !== JSON.stringify(manifest.copy.kernel) ||
	JSON.stringify(provenance.ownership?.owned) !== JSON.stringify(manifest.copy.owned)
) {
	fail("ue-shed-provenance.json does not match the manifest contract");
}

const scanRoots = [...declaredEntries, "app/package.json", "app/src", "app/vite.config.ts"];
for (const scanRoot of scanRoots) {
	for (const path of await filesUnder(join(targetRoot, scanRoot))) {
		if (!/\.(?:css|html|js|json|mjs|ts|tsx|yaml)$/i.test(path)) continue;
		const content = await readFile(path, "utf8");
		if (/apps[\\/]workbench|window\.ueShed|from ["']electron/.test(content)) {
			fail(`forbidden host authority in ${relative(targetRoot, path)}`);
		}
		if (/\bnpm_[A-Za-z0-9]{20,}\b|_authToken\s*=\s*[^\s"']+/i.test(content)) {
			fail(`credential-like content in ${relative(targetRoot, path)}`);
		}
	}
}

const route = await readFile(
	join(targetRoot, "extensions", "data-authoring", "src", "authoring-route.tsx"),
	"utf8"
);
if (!route.includes("tokens.colorAccent") || route.includes("#b7e26d")) {
	fail("the owned route does not consume the semantic accent coherently");
}
const theme = await readFile(
	join(targetRoot, "packages", "ui-theme", "src", "themes.stylex.ts"),
	"utf8"
);
if (!theme.toLowerCase().includes(expectedAccent.toLowerCase())) {
	fail(`the applied theme does not contain ${expectedAccent}`);
}

const pnpmScript = process.env.npm_execpath;
const scriptIsJavaScript = pnpmScript ? /\.(?:c|m)?js$/i.test(pnpmScript) : false;
const command = scriptIsJavaScript
	? process.execPath
	: (pnpmScript ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm"));
const prefix = scriptIsJavaScript && pnpmScript ? [pnpmScript] : [];
const build = spawnSync(command, [...prefix, "--filter", "foreign-authoring-host", "build"], {
	cwd: targetRoot,
	env: {
		...process.env,
		CI: "1",
		NODE_AUTH_TOKEN: "",
		NPM_TOKEN: ""
	},
	shell: process.platform === "win32" && (!pnpmScript || /\.(?:cmd|bat)$/i.test(pnpmScript)),
	stdio: "inherit",
	windowsHide: true
});
if (build.error) throw build.error;
if (build.status !== 0) fail(`production build exited ${build.status ?? 1}`);

const css = await readFile(join(targetRoot, "app", "dist", "stylex.css"), "utf8");
if (css.length === 0) fail("production stylex.css is empty");
if (!css.toLowerCase().includes(expectedAccent.toLowerCase())) {
	fail(`production stylex.css does not contain ${expectedAccent}`);
}

console.log(
	`Data Authoring target verification passed: ${declaredEntries.length} declared entries, ` +
		`${css.length} bytes of StyleX CSS, ${expectedAccent} divergence verified.`
);
