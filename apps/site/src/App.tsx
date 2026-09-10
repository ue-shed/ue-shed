import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For } from "solid-js";
import { AuthoringMock } from "./showcase/AuthoringMock.js";
import { Showcase } from "./showcase/Showcase.js";
import { Terminal } from "./Terminal.js";
import { approach, diagram, facts, inspectTerminal, repositoryUrl, tools } from "./content.js";

export function App() {
	return (
		<div {...stylex.attrs(styles.page)}>
			<div {...stylex.attrs(styles.container)}>
				<header {...stylex.attrs(styles.nav)}>
					<span {...stylex.attrs(styles.wordmark)}>ue-shed</span>
					<nav {...stylex.attrs(styles.navLinks)}>
						<a href="#showcase" {...stylex.attrs(styles.navLink)}>
							Showcase
						</a>
						<a href="#tools" {...stylex.attrs(styles.navLink)}>
							Tools
						</a>
						<a href="#approach" {...stylex.attrs(styles.navLink)}>
							Headless-first
						</a>
						<a href={repositoryUrl} {...stylex.attrs(styles.navLink)}>
							GitHub ↗
						</a>
					</nav>
				</header>

				<main>
					<section {...stylex.attrs(styles.hero)}>
						<p {...stylex.attrs(styles.eyebrow)}>Open source · headless-first</p>
						<h1 {...stylex.attrs(styles.h1)}>
							Unreal tooling that runs without Unreal.
						</h1>
						<p {...stylex.attrs(styles.heroSub)}>
							Headless-first libraries and a CLI for inspecting, auditing, and
							authoring Unreal content from outside the editor. Live plugins and a
							desktop showcase app included — separately enabled, never required.
						</p>
						<div {...stylex.attrs(styles.ctaRow)}>
							<a href={repositoryUrl} {...stylex.attrs(styles.buttonPrimary)}>
								View on GitHub ↗
							</a>
							<a href="#approach" {...stylex.attrs(styles.buttonGhost)}>
								How it's put together
							</a>
						</div>
						<div {...stylex.attrs(styles.heroTrial)}>
							<AuthoringMock />
						</div>
					</section>

					<section id="showcase" {...stylex.attrs(styles.showcaseSection)}>
						<Showcase />
					</section>

					<section {...stylex.attrs(styles.facts)}>
						<For each={facts}>
							{(fact) => (
								<div>
									<p {...stylex.attrs(styles.factLabel)}>{fact.label}</p>
									<p {...stylex.attrs(styles.factText)}>{fact.text}</p>
								</div>
							)}
						</For>
					</section>

					<section id="tools" {...stylex.attrs(styles.section)}>
						<header {...stylex.attrs(styles.sectionHead)}>
							<p {...stylex.attrs(styles.eyebrow)}>The suite</p>
							<h2 {...stylex.attrs(styles.h2)}>In the shed</h2>
							<p {...stylex.attrs(styles.sectionSub)}>
								Each tool stands alone. Take one, leave the rest.
							</p>
						</header>
						<div {...stylex.attrs(styles.toolsGrid)}>
							<For each={tools}>
								{(tool) => (
									<article {...stylex.attrs(styles.toolCard)}>
										<h3 {...stylex.attrs(styles.toolName)}>{tool.name}</h3>
										<p {...stylex.attrs(styles.toolLine)}>{tool.line}</p>
										<span {...stylex.attrs(styles.toolTag)}>{tool.tag}</span>
									</article>
								)}
							</For>
						</div>
					</section>

					<section id="approach" {...stylex.attrs(styles.section)}>
						<header {...stylex.attrs(styles.sectionHead)}>
							<p {...stylex.attrs(styles.eyebrow)}>Headless-first</p>
							<h2 {...stylex.attrs(styles.h2)}>Decoupled from Unreal</h2>
							<p {...stylex.attrs(styles.sectionSub)}>
								The libraries lead; the CLI and the Workbench follow. Everything
								below works from a shell — the app is optional.
							</p>
						</header>
						<Terminal spec={inspectTerminal} />
						<p {...stylex.attrs(styles.caption)}>
							A saved DataTable read straight from its .uasset package. No editor
							running.
						</p>
						<div {...stylex.attrs(styles.approachList)}>
							<For each={approach}>
								{(point, index) => (
									<div {...stylex.attrs(styles.approachItem)}>
										<span {...stylex.attrs(styles.approachNum)}>
											{String(index() + 1).padStart(2, "0")}
										</span>
										<div>
											<h3 {...stylex.attrs(styles.approachTitle)}>
												{point.title}
											</h3>
											<p {...stylex.attrs(styles.approachText)}>
												{point.text}
											</p>
										</div>
									</div>
								)}
							</For>
						</div>
						<pre {...stylex.attrs(styles.diagram)}>{diagram.trim()}</pre>
					</section>

					<section id="open-source" {...stylex.attrs(styles.section)}>
						<div {...stylex.attrs(styles.ossBand)}>
							<p {...stylex.attrs(styles.eyebrow)}>Open source</p>
							<h2 {...stylex.attrs(styles.h2)}>Open source, end to end.</h2>
							<p {...stylex.attrs(styles.ossText)}>
								The tools, the Unreal plugins, the fixture project they test
								against, and this site. Take what's useful — the parts you leave
								behind don't come along.
							</p>
							<a href={repositoryUrl} {...stylex.attrs(styles.buttonPrimary)}>
								ue-shed/ue-shed on GitHub ↗
							</a>
							<p {...stylex.attrs(styles.ossNote)}>
								Early stage: some tools are finished workflows, others are proving
								slices. The repo says which is which.
							</p>
						</div>
					</section>
				</main>

				<footer {...stylex.attrs(styles.footer)}>
					<span>ue-shed — external tools for Unreal Engine development</span>
					<span>
						Not affiliated with Epic Games. Unreal® is a trademark of Epic Games, Inc.
					</span>
				</footer>
			</div>
		</div>
	);
}

const styles = stylex.create({
	page: {
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		lineHeight: 1.6,
		minHeight: "100vh"
	},
	container: {
		margin: "0 auto",
		maxWidth: 1080,
		padding: "0 24px"
	},
	nav: {
		alignItems: "center",
		display: "flex",
		flexWrap: "wrap",
		gap: 16,
		justifyContent: "space-between",
		padding: "26px 0"
	},
	wordmark: {
		color: tokens.colorTextStrong,
		fontSize: 15,
		fontWeight: 700,
		letterSpacing: ".04em"
	},
	navLinks: {
		display: "flex",
		gap: 22
	},
	navLink: {
		color: {
			default: tokens.colorTextMuted,
			":hover": tokens.colorTextStrong
		},
		fontSize: 12,
		textDecoration: "none"
	},
	hero: {
		padding: "72px 0 56px"
	},
	eyebrow: {
		color: tokens.colorAccent,
		fontSize: 10,
		letterSpacing: ".22em",
		margin: 0,
		textTransform: "uppercase"
	},
	h1: {
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: "clamp(2.2rem, 5.2vw, 3.6rem)",
		fontWeight: 400,
		lineHeight: 1.1,
		margin: "18px 0",
		maxWidth: "20ch"
	},
	heroSub: {
		color: tokens.colorTextMuted,
		fontSize: 14,
		margin: "0 0 30px",
		maxWidth: "62ch"
	},
	ctaRow: {
		display: "flex",
		flexWrap: "wrap",
		gap: 12,
		marginBottom: 44
	},
	buttonPrimary: {
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong
		},
		borderColor: tokens.colorAccent,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorAccentText,
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: ".08em",
		padding: "12px 18px",
		textDecoration: "none",
		textTransform: "uppercase"
	},
	buttonGhost: {
		backgroundColor: {
			default: "transparent",
			":hover": tokens.colorSurfaceHover
		},
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorText,
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: ".08em",
		padding: "12px 18px",
		textDecoration: "none",
		textTransform: "uppercase"
	},
	caption: {
		color: tokens.colorTextSubtle,
		fontSize: 11,
		margin: "14px 0 0"
	},
	heroTrial: {
		marginTop: 44
	},
	facts: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		display: "grid",
		gap: 28,
		gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
		padding: "28px 0"
	},
	factLabel: {
		color: tokens.colorAccent,
		fontSize: 10,
		letterSpacing: ".2em",
		margin: "0 0 8px",
		textTransform: "uppercase"
	},
	factText: {
		color: tokens.colorTextMuted,
		fontSize: 12,
		margin: 0
	},
	section: {
		padding: "72px 0"
	},
	showcaseSection: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		padding: "56px 0 64px"
	},
	sectionHead: {
		marginBottom: 36
	},
	h2: {
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: "clamp(1.7rem, 3vw, 2.4rem)",
		fontWeight: 400,
		lineHeight: 1.15,
		margin: "14px 0 10px"
	},
	sectionSub: {
		color: tokens.colorTextMuted,
		margin: 0,
		maxWidth: "60ch"
	},
	toolsGrid: {
		display: "grid",
		gap: 12,
		gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))"
	},
	toolCard: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		display: "flex",
		flexDirection: "column",
		gap: 10,
		padding: 18
	},
	toolName: {
		color: tokens.colorTextStrong,
		fontSize: 13,
		fontWeight: 700,
		margin: 0
	},
	toolLine: {
		color: tokens.colorTextMuted,
		flexGrow: 1,
		fontSize: 12,
		margin: 0
	},
	toolTag: {
		color: tokens.colorTextSubtle,
		fontSize: 9,
		letterSpacing: ".18em",
		textTransform: "uppercase"
	},
	approachList: {
		display: "grid",
		gap: 26,
		marginTop: 40
	},
	approachItem: {
		display: "grid",
		gap: 18,
		gridTemplateColumns: "44px 1fr"
	},
	approachNum: {
		color: tokens.colorTextFaint,
		fontSize: 12,
		paddingTop: 2
	},
	approachTitle: {
		color: tokens.colorTextStrong,
		fontSize: 14,
		fontWeight: 700,
		margin: "0 0 6px"
	},
	approachText: {
		color: tokens.colorTextMuted,
		fontSize: 12,
		margin: 0,
		maxWidth: "64ch"
	},
	diagram: {
		backgroundColor: tokens.colorSurfaceInset,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontBody,
		fontSize: 11,
		lineHeight: 1.9,
		margin: "36px 0 0",
		overflowX: "auto",
		padding: "20px 22px",
		whiteSpace: "pre"
	},
	ossBand: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		padding: 36
	},
	ossText: {
		color: tokens.colorTextMuted,
		fontSize: 13,
		margin: "0 0 26px",
		maxWidth: "58ch"
	},
	ossNote: {
		color: tokens.colorTextSubtle,
		fontSize: 11,
		margin: "26px 0 0"
	},
	footer: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextFaint,
		display: "flex",
		flexWrap: "wrap",
		fontSize: 10.5,
		gap: 12,
		justifyContent: "space-between",
		padding: "26px 0 42px"
	}
});
