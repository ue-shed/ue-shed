/**
 * Page scripts the desktop Game Text benchmark evaluates in the Workbench renderer. They are
 * strings, not functions, because the TypeScript loader would otherwise inject helpers the page
 * does not have.
 */

/**
 * Records the search count's text and the time of the page's next Enter in the search box. A
 * fast search can show "Searching…" and restore the same count between two polls, so an
 * observer installed before Enter latches the busy state and the completion as they happen.
 */
export const searchRecorder = `(() => {
	const input = document.querySelector('input[aria-label="Search game text"]');
	const countText = () => {
		let count = input?.nextElementSibling;
		while (count && count.getAttribute("role") !== "status") count = count.nextElementSibling;
		return count ? (count.innerText ?? count.textContent ?? "") : "";
	};
	const search = { before: countText(), pressedAt: undefined, searching: false, doneAt: undefined };
	window.__ueShedSearch = search;
	const observer = new MutationObserver((records) => {
		if (search.pressedAt === undefined || search.doneAt !== undefined) return;
		const text = countText();
		if (
			text === "Searching…" ||
			records.some(
				(record) =>
					record.oldValue === "Searching…" ||
					[...record.removedNodes].some((node) => node.textContent === "Searching…")
			)
		)
			search.searching = true;
		if (search.searching && /match/u.test(text)) {
			search.doneAt = Date.now();
			observer.disconnect();
		}
	});
	if (input?.parentElement)
		observer.observe(input.parentElement, {
			characterData: true,
			characterDataOldValue: true,
			childList: true,
			subtree: true
		});
	input?.addEventListener("keydown", (event) => {
		if (event.key === "Enter") search.pressedAt = Date.now();
	}, { capture: true, once: true });
})()`;

/** Resolves once the search after Enter has finished: the latched completion, else a poll. */
export const searchDoneInPage = `(() => {
	const search = window.__ueShedSearch;
	if (!search || search.pressedAt === undefined) return false;
	if (search.doneAt !== undefined) return { pressedAt: search.pressedAt, doneAt: search.doneAt };
	let count = document.querySelector('input[aria-label="Search game text"]')?.nextElementSibling;
	while (count && count.getAttribute("role") !== "status") count = count.nextElementSibling;
	const text = count ? (count.innerText ?? count.textContent ?? "") : "";
	if (text === "Searching…") search.searching = true;
	return /match/u.test(text) && (search.searching || text !== search.before)
		? { pressedAt: search.pressedAt, doneAt: Date.now() }
		: false;
})()`;
