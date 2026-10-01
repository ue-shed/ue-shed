import { createSignal, onSettled } from "solid-js";

/** Keep native anchor behavior for modified clicks, downloads, external links, and new tabs. */
export function isPlainNavigation(event: MouseEvent): boolean {
	return (
		!event.defaultPrevented &&
		event.button === 0 &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey
	);
}

export function createSitePathname() {
	const [pathname, setPathname] = createSignal(
		window.location.pathname.replace(/\/$/, "") || "/"
	);
	onSettled(() => {
		const update = () => setPathname(window.location.pathname.replace(/\/$/, "") || "/");
		const click = (event: MouseEvent) => {
			if (!isPlainNavigation(event) || !(event.target instanceof Element)) return;
			const anchor = event.target.closest("a[href]");
			if (
				!(anchor instanceof HTMLAnchorElement) ||
				anchor.hasAttribute("download") ||
				(anchor.target !== "" && anchor.target !== "_self")
			)
				return;
			const url = new URL(anchor.href);
			if (url.origin !== window.location.origin || url.pathname === window.location.pathname)
				return;
			if (
				!/^\/(?:docs(?:\/.*)?|blueprints\/?|sequencer\/?|data-tables\/?|inspect\/?)?$/.test(
					url.pathname
				)
			)
				return;
			event.preventDefault();
			window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
			update();
			window.scrollTo(0, 0);
		};
		document.addEventListener("click", click);
		window.addEventListener("popstate", update);
		return () => {
			document.removeEventListener("click", click);
			window.removeEventListener("popstate", update);
		};
	});
	return pathname;
}
