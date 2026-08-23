import type { JSX } from "solid-js";

function Icon(props: { readonly children: JSX.Element }) {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="15"
			stroke="currentColor"
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="1.4"
			viewBox="0 0 16 16"
			width="15"
		>
			{props.children}
		</svg>
	);
}

export function IconGrid() {
	return (
		<Icon>
			<rect height="4.5" rx="1" width="4.5" x="2.5" y="2.5" />
			<rect height="4.5" rx="1" width="4.5" x="9" y="2.5" />
			<rect height="4.5" rx="1" width="4.5" x="2.5" y="9" />
			<rect height="4.5" rx="1" width="4.5" x="9" y="9" />
		</Icon>
	);
}

export function IconImage() {
	return (
		<Icon>
			<rect height="11" rx="1.5" width="11" x="2.5" y="2.5" />
			<circle cx="6" cy="6" r="1.1" />
			<path d="M2.5 11l3.2-3.2a1 1 0 0 1 1.4 0L13.5 13" />
		</Icon>
	);
}

export function IconSliders() {
	return (
		<Icon>
			<path d="M3 4.5h10M3 8h10M3 11.5h10" />
			<circle cx="6" cy="4.5" r="1.4" />
			<circle cx="10.5" cy="8" r="1.4" />
			<circle cx="5" cy="11.5" r="1.4" />
		</Icon>
	);
}

export function IconGamepad() {
	return (
		<Icon>
			<path d="M5.5 4.5h5a3.5 3.5 0 0 1 3.4 2.7l.7 3A2 2 0 0 1 12.66 13c-.86 0-1.32-.62-1.91-1.25-.4-.43-.98-.75-1.75-.75H7c-.77 0-1.35.32-1.75.75C4.66 12.38 4.2 13 3.34 13A2 2 0 0 1 1.4 10.2l.7-3A3.5 3.5 0 0 1 5.5 4.5z" />
			<path d="M5.25 7.25v2.5M4 8.5h2.5" />
			<circle cx="10.75" cy="7.75" r="0.4" />
			<circle cx="12" cy="9.25" r="0.4" />
		</Icon>
	);
}

export function IconType() {
	return (
		<Icon>
			<path d="M3 4.5h10M8 4.5V13" />
		</Icon>
	);
}

export function IconTable() {
	return (
		<Icon>
			<rect height="11" rx="1.5" width="11" x="2.5" y="2.5" />
			<path d="M2.5 6.5h11M2.5 10.5h11M8 6.5V13.5" />
		</Icon>
	);
}

export function IconTimeline() {
	return (
		<Icon>
			<path d="M2.5 4h11M2.5 8h7M2.5 12h11" />
			<circle cx="11.5" cy="8" r="1.6" />
		</Icon>
	);
}

export function IconShield() {
	return (
		<Icon>
			<path d="M8 2.5l5 1.8v3.9c0 2.9-2.1 4.8-5 5.8-2.9-1-5-2.9-5-5.8V4.3z" />
			<path d="M5.8 7.9l1.6 1.6 2.8-3" />
		</Icon>
	);
}

export function IconMap() {
	return (
		<Icon>
			<path d="M2.5 4l3.5-1.5L10 4l3.5-1.5v9.5L10 13.5 6 12l-3.5 1.5z" />
			<path d="M6 2.5v9.5M10 4v9.5" />
		</Icon>
	);
}

export function IconLayers() {
	return (
		<Icon>
			<path d="M8 2.5l5.5 3-5.5 3-5.5-3z" />
			<path d="M2.5 8.5L8 11.5l5.5-3M2.5 11.5L8 14.5l5.5-3" />
		</Icon>
	);
}

export function IconSparkles() {
	return (
		<Icon>
			<path d="M8 2.5l1.2 3.3L12.5 7l-3.3 1.2L8 11.5 6.8 8.2 3.5 7l3.3-1.2z" />
			<path d="M12.5 10.5l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z" />
		</Icon>
	);
}

export function IconHistory() {
	return (
		<Icon>
			<path d="M2.5 8a5.5 5.5 0 1 1 1.61 3.89M2.5 8V5.5M2.5 8H5" />
			<path d="M8 5.5V8l2 1.5" />
		</Icon>
	);
}

export function IconVideo() {
	return (
		<Icon>
			<rect height="8" rx="1.5" width="9" x="2.5" y="4" />
			<path d="M11.5 7.5l3-2v5l-3-2z" />
		</Icon>
	);
}
