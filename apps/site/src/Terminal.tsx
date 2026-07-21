import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For } from "solid-js";
import type { TerminalSpec } from "./content.js";
import { WindowFrame } from "./showcase/WindowFrame.js";

type TokenKind = "key" | "string" | "plain";

type Token = {
	readonly text: string;
	readonly kind: TokenKind;
};

// Lightweight JSON-ish highlighting: quoted text followed by a colon is a key,
// any other quoted text is a string value, everything else is punctuation.
function tokenize(line: string): readonly Token[] {
	const result: Token[] = [];
	const pattern = /"[^"]*"(\s*:)?/g;
	let last = 0;
	for (const match of line.matchAll(pattern)) {
		const quoted = match[0];
		const colon = match[1];
		const index = match.index ?? 0;
		if (index > last) {
			result.push({ text: line.slice(last, index), kind: "plain" });
		}
		if (colon === undefined) {
			result.push({ text: quoted, kind: "string" });
		} else {
			result.push({ text: quoted.slice(0, quoted.length - colon.length), kind: "key" });
			result.push({ text: colon, kind: "plain" });
		}
		last = index + quoted.length;
	}
	if (last < line.length) {
		result.push({ text: line.slice(last), kind: "plain" });
	}
	return result;
}

export function Terminal(props: { readonly spec: TerminalSpec }) {
	return (
		<WindowFrame title={props.spec.title}>
			<pre {...stylex.props(styles.body)}>
				<For each={props.spec.lines}>
					{(line) => (
						<span>
							{line.kind === "command" ? (
								<>
									<span {...stylex.props(styles.prompt)}>$ </span>
									<span {...stylex.props(styles.command)}>{line.text}</span>
								</>
							) : (
								<For each={tokenize(line.text)}>
									{(token) => (
										<span {...stylex.props(styles[token.kind])}>
											{token.text}
										</span>
									)}
								</For>
							)}
							{"\n"}
						</span>
					)}
				</For>
			</pre>
		</WindowFrame>
	);
}

const styles = stylex.create({
	body: {
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontBody,
		fontSize: 11.5,
		lineHeight: 1.8,
		margin: 0,
		overflowX: "auto",
		padding: "16px 18px"
	},
	prompt: {
		color: tokens.colorAccent,
		userSelect: "none"
	},
	command: {
		color: tokens.colorTextStrong
	},
	key: {
		color: tokens.colorWarning
	},
	string: {
		color: tokens.colorAccent
	},
	plain: {
		color: tokens.colorTextFaint
	}
});
