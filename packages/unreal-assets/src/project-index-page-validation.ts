import { Schema } from "effect";
import type { ProjectIndexPage } from "./project-index.js";

const validatedPages = new WeakMap<object, ProjectIndexPage>();
const isObject = Schema.is(Schema.ObjectKeyword);

/** Internal: call only after validating every page field against the domain constraints. */
export function retainValidatedPage(page: ProjectIndexPage): ProjectIndexPage {
	for (const item of page.items) {
		if (item.kind === "header") {
			Object.freeze(item.classes);
			Object.freeze(item.serializedNames);
		}
		Object.freeze(item);
	}
	Object.freeze(page.items);
	Object.freeze(page);
	validatedPages.set(page, page);
	return page;
}

export function findValidatedPage<Input>(input: Input): ProjectIndexPage | undefined {
	return isObject(input) ? validatedPages.get(input) : undefined;
}
