import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For } from "solid-js";
import { AuthoringMock } from "./showcase/AuthoringMock.js";
import { Showcase } from "./showcase/Showcase.js";
import { Terminal } from "./Terminal.js";
import { approach, diagram, facts, inspectTerminal, repositoryUrl, tools } from "./content.js";

export function App() {
	return (
		<div {...stylex.props(styles.page)}>
			<div {...stylex.props(styles.container)}>
				<header {...stylex.props(styles.nav)}>
					<span {...stylex.props(styles.wordmark)}>ue-shed</span>
					<nav {...stylex.props(styles.navLinks)}>
						<a href="#showcase" {...stylex.props(styles.navLink)}>
							Showcase
						</a>
						<a href="#tools" {...stylex.props(styles.navLink)}>
							Tools
						</a>
						<a href="#approach" {...stylex.props(styles.navLink)}>
							Headless-first
						</a>
						<a href={repositoryUrl} {...stylex.props(styles.navLink)}>
							GitHub ↗
						</a>
					</nav>
				</header>

				<main>
					<section {...stylex.props(styles.hero)}>
						<p {...stylex.props(styles.eyebrow)}>Open source · headless-first</p>
						<h1 {...stylex.props(styles.h1)}>
							Unreal tooling that runs without Unreal.
						</h1>
						<p {...stylex.props(styles.heroSub)}>
							Headless-first libraries and a CLI for inspecting, auditing, and
							authoring Unreal content from outside the editor. Live plugins and a
							desktop showcase app included — separately enabled, never required.
						</p>
						<div {...stylex.props(styles.ctaRow)}>
							<a href={repositoryUrl} {...stylex.props(styles.buttonPrimary)}>
								View on GitHub ↗
							</a>
							<a href="#approach" {...stylex.props(styles.buttonGhost)}>
								How it's put together
							</a>
						</div>
						<div {...stylex.props(styles.heroTrial)}>
							<AuthoringMock />
						</div>
					</section>

					<section id="showcase" {...stylex.props(styles.showcaseSection)}>
						<Showcase />
					</section>

					<section {...stylex.props(styles.facts)}>
						<For each={facts}>
							{(fact) => (
								<div>
									<p {...stylex.props(styles.factLabel)}>{fact.label}</p>
									<p {...stylex.props(styles.factText)}>{fact.text}</p>
								</div>
							)}
						</For>
					</section>

					<section id="tools" {...stylex.props(styles.section)}>
						<header {...stylex.props(styles.sectionHead)}>
							<p {...stylex.props(styles.eyebrow)}>The suite</p>
							<h2 {...stylex.props(styles.h2)}>In the shed</h2>
							<p {...stylex.props(styles.sectionSub)}>
								Each tool stands alone. Take one, leave the rest.
							</p>
						</header>
						<div {...stylex.props(styles.toolsGrid)}>
							<For each={tools}>
								{(tool) => (
									<article {...stylex.props(styles.toolCard)}>
										<h3 {...stylex.props(styles.toolName)}>{tool.name}</h3>
										<p {...stylex.props(styles.toolLine)}>{tool.line}</p>
										<span {...stylex.props(styles.toolTag)}>{tool.tag}</span>
									</article>
								)}
							</For>
						</div>
					</section>

					<section id="approach" {...stylex.props(styles.section)}>
						<header {...stylex.props(styles.sectionHead)}>
							<p {...stylex.props(styles.eyebrow)}>Headless-first</p>
							<h2 {...stylex.props(styles.h2)}>Decoupled from Unreal</h2>
							<p {...stylex.props(styles.sectionSub)}>
								The libraries lead; the CLI and the Workbench follow. Everything
								below works from a shell — the app is optional.
							</p>
						</header>
						<Terminal spec={inspectTerminal} />
						<p {...stylex.props(styles.caption)}>
							A saved DataTable read straight from its .uasset package. No editor
							running.
						</p>
						<div {...stylex.props(styles.approachList)}>
							<For each={approach}>
								{(point, index) => (
									<div {...stylex.props(styles.approachItem)}>
										<span {...stylex.props(styles.approachNum)}>
											{String(index() + 1).padStart(2, "0")}
										</span>
										<div>
											<h3 {...stylex.props(styles.approachTitle)}>
												{point.title}
											</h3>
											<p {...stylex.props(styles.approachText)}>
												{point.text}
											</p>
										</div>
									</div>
								)}
							</For>
						</div>
						<pre {...stylex.props(styles.diagram)}>{diagram.trim()}</pre>
					</section>

					<section id="open-source" {...stylex.props(styles.section)}>
						<div {...stylex.props(styles.ossBand)}>
							<p {...stylex.props(styles.eyebrow)}>Open source</p>
							<h2 {...stylex.props(styles.h2)}>Open source, end to end.</h2>
							<p {...stylex.props(styles.ossText)}>
								The tools, the Unreal plugins, the fixture project they test
								against, and this site. Take what's useful — the parts you leave
								behind don't come along.
							</p>
							<a href={repositoryUrl} {...stylex.props(styles.buttonPrimary)}>
								peculiarnewbie/ue-shed on GitHub ↗
							</a>
							<p {...stylex.props(styles.ossNote)}>
								Early stage: some tools are finished workflows, others are proving
								slices. The repo says which is which.
							</p>
						</div>
					</section>
				</main>

				<footer {...stylex.props(styles.footer)}>
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
