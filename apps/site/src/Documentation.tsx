import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show } from "solid-js";
import { repositoryUrl } from "./content.js";
import { guides } from "./guides.js";
import { siteMedia } from "./showcase/media.js";

export function Documentation() {
	const slug =
		window.location.pathname.replace(/\/$/, "").split("/").slice(2).join("/") ||
		"getting-started";
	const guide = guides.find((entry) => entry.slug === slug);
	document.title = `${guide?.title ?? "Guide not found"} · UE Shed docs`;
	return (
		<div {...stylex.attrs(styles.page)}>
			<a href="#guide" {...stylex.attrs(styles.skip)}>
				Skip to guide
			</a>
			<header {...stylex.attrs(styles.header)}>
				<a href="/" {...stylex.attrs(styles.brand)}>
					ue-shed <span {...stylex.attrs(styles.muted)}>/ docs</span>
				</a>
				<nav aria-label="Main" {...stylex.attrs(styles.links)}>
					<a href="/blueprints" {...stylex.attrs(styles.link)}>
						Blueprint viewer
					</a>
					<a href="/sequencer" {...stylex.attrs(styles.link)}>
						Sequencer viewer
					</a>
					<a href="/data-tables" {...stylex.attrs(styles.link)}>
						Data tables
					</a>
					<a href="/inspect" {...stylex.attrs(styles.link)}>
						Asset inspector
					</a>
					<a href="/#showcase" {...stylex.attrs(styles.link)}>
						Showcase
					</a>
					<a href={repositoryUrl} {...stylex.attrs(styles.link)}>
						GitHub ↗
					</a>
				</nav>
			</header>
			<div {...stylex.attrs(styles.layout)}>
				<nav aria-label="Guides" {...stylex.attrs(styles.sidebar)}>
					<p {...stylex.attrs(styles.eyebrow)}>Field guide</p>
					<For each={guides}>
						{(entry, index) => (
							<a
								href={`/docs/${entry.slug}`}
								aria-current={entry.slug === slug ? "page" : undefined}
								{...stylex.attrs(
									styles.guideLink,
									entry.slug === slug && styles.active
								)}
							>
								<span {...stylex.attrs(styles.number)}>
									{String(index() + 1).padStart(2, "0")}
								</span>
								{entry.slug === "getting-started"
									? "Getting started"
									: entry.slug
											.split("-")
											.map(
												(word) =>
													word.charAt(0).toUpperCase() + word.slice(1)
											)
											.join(" ")}
							</a>
						)}
					</For>
					<a
						href={`${repositoryUrl}/blob/main/docs/README.md`}
						{...stylex.attrs(styles.source)}
					>
						Engineering & contracts ↗
					</a>
				</nav>
				<main id="guide" {...stylex.attrs(styles.article)}>
					<Show
						when={guide}
						fallback={
							<>
								<h1>Guide not found</h1>
								<a href="/docs" {...stylex.attrs(styles.link)}>
									Start with the field guide →
								</a>
							</>
						}
					>
						{(current) => (
							<>
								<p {...stylex.attrs(styles.eyebrow)}>{current().requirement}</p>
								<h1 {...stylex.attrs(styles.title)}>{current().title}</h1>
								<p {...stylex.attrs(styles.intro)}>{current().summary}</p>
								<ol {...stylex.attrs(styles.steps)}>
									<For each={current().steps}>
										{(step) => (
											<li {...stylex.attrs(styles.step)}>
												<h2 {...stylex.attrs(styles.stepTitle)}>
													{step.title}
												</h2>
												<p {...stylex.attrs(styles.text)}>{step.text}</p>
											</li>
										)}
									</For>
								</ol>
								<section aria-label="Commands" {...stylex.attrs(styles.section)}>
									<h2 {...stylex.attrs(styles.stepTitle)}>
										{slug === "getting-started"
											? "From a fresh checkout"
											: "From the repository shell"}
									</h2>
									<pre {...stylex.attrs(styles.command)}>
										<code>{current().command}</code>
									</pre>
								</section>
								<For each={current().captures}>
									{(entry) => {
										const capture = siteMedia.captures[entry.key];
										const recording = siteMedia.journeys[capture.journey];
										return (
											<figure {...stylex.attrs(styles.figure)}>
												<a
													href={`/media/${capture.file}`}
													aria-label={`Open full-size screenshot: ${capture.title}`}
												>
													<img
														src={`/media/${capture.file}`}
														alt={entry.caption}
														loading="lazy"
														{...stylex.attrs(styles.image)}
													/>
												</a>
												<figcaption {...stylex.attrs(styles.caption)}>
													{entry.caption}
													<span {...stylex.attrs(styles.provenance)}>
														Recorded {recording.finishedAt.slice(0, 10)}{" "}
														·{" "}
														<a
															href={`${repositoryUrl}/commit/${recording.commit}`}
															{...stylex.attrs(styles.link)}
														>
															{recording.commit}
														</a>
														{recording.dirty ? " + local changes" : ""}{" "}
														· Open image for full size
													</span>
												</figcaption>
											</figure>
										);
									}}
								</For>
								<aside {...stylex.attrs(styles.boundary)}>
									<h2 {...stylex.attrs(styles.stepTitle)}>What this covers</h2>
									<p {...stylex.attrs(styles.text)}>{current().boundary}</p>
								</aside>
								<a
									href={`${repositoryUrl}/blob/main/${current().source}`}
									{...stylex.attrs(styles.source)}
								>
									Read the full workflow and product contract ↗
								</a>
							</>
						)}
					</Show>
				</main>
			</div>
			<footer {...stylex.attrs(styles.footer)}>
				UE Shed · Open source tools for Unreal Engine development. Not affiliated with Epic
				Games.
			</footer>
		</div>
	);
}

const styles = stylex.create({
	page: {
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 14,
		lineHeight: 1.7,
		minHeight: "100vh",
		padding: "0 24px"
	},
	header: {
		alignItems: "center",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		flexWrap: "wrap",
		gap: 20,
		justifyContent: "space-between",
		margin: "0 auto",
		maxWidth: 1280,
		padding: "28px 0"
	},
	brand: { color: tokens.colorTextStrong, fontSize: 17, fontWeight: 700, textDecoration: "none" },
	muted: { color: tokens.colorTextSubtle, fontWeight: 400 },
	links: { display: "flex", gap: 24 },
	link: { color: tokens.colorAccent, textUnderlineOffset: 4 },
	layout: {
		display: "grid",
		gap: 56,
		gridTemplateColumns: {
			default: "220px minmax(0, 1fr)",
			"@media (max-width: 800px)": "minmax(0, 1fr)"
		},
		margin: "0 auto",
		maxWidth: 1280,
		padding: "48px 0 80px"
	},
	sidebar: {
		alignSelf: "start",
		display: "flex",
		flexDirection: "column",
		gap: 8,
		position: { default: "sticky", "@media (max-width: 800px)": "static" },
		top: 24
	},
	eyebrow: {
		color: tokens.colorAccent,
		fontSize: 11,
		letterSpacing: ".08em",
		margin: "0 0 18px",
		textTransform: "uppercase"
	},
	guideLink: {
		borderRadius: 6,
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorTextStrong },
		display: "flex",
		gap: 12,
		padding: "10px 12px",
		textDecoration: "none"
	},
	active: { backgroundColor: tokens.colorSurface, color: tokens.colorTextStrong },
	number: { color: tokens.colorTextSubtle, fontSize: 11, paddingTop: 2 },
	article: { minWidth: 0, maxWidth: 920 },
	title: {
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: "clamp(2rem, 4.5vw, 3.4rem)",
		fontWeight: 400,
		lineHeight: 1.1,
		margin: "0 0 24px",
		maxWidth: "23ch"
	},
	intro: { color: tokens.colorTextMuted, fontSize: 18, margin: "0 0 40px", maxWidth: "65ch" },
	steps: { margin: 0, paddingLeft: 24 },
	step: { paddingLeft: 12, marginBottom: 28 },
	stepTitle: { color: tokens.colorTextStrong, fontSize: 16, fontWeight: 600, margin: "0 0 8px" },
	text: { color: tokens.colorTextMuted, margin: 0, maxWidth: "78ch" },
	section: { margin: "40px 0" },
	command: {
		backgroundColor: tokens.colorSurfaceInset,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: 8,
		color: tokens.colorText,
		fontSize: 12,
		lineHeight: 1.9,
		overflowX: "auto",
		padding: 20
	},
	figure: { margin: "40px 0" },
	image: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: 8,
		display: "block",
		height: "auto",
		width: "100%"
	},
	caption: { color: tokens.colorTextMuted, fontSize: 12, marginTop: 12 },
	provenance: { color: tokens.colorTextSubtle, display: "block", fontSize: 11, marginTop: 4 },
	boundary: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorAccent,
		borderStyle: "solid",
		borderWidth: 1,
		padding: 24
	},
	source: {
		color: tokens.colorAccent,
		display: "block",
		fontSize: 12,
		marginTop: 24,
		textUnderlineOffset: 4
	},
	footer: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		margin: "0 auto",
		maxWidth: 1280,
		padding: "24px 0"
	},
	skip: {
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorAccent,
		left: 16,
		padding: 12,
		position: "absolute",
		top: { default: -100, ":focus": 0 },
		zIndex: 10
	}
});
