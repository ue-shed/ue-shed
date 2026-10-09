/**
 * Unreal's StripPackageNamespace. JS trimEnd matches FChar::IsWhitespace for spaces/tabs;
 * other Unicode whitespace follows JavaScript rather than Unreal's platform C locale.
 */
export function stripPackageNamespace(namespace: string): string {
	if (!namespace.endsWith("]")) return namespace;
	const start = namespace.lastIndexOf("[");
	return start < 0 ? namespace : namespace.slice(0, start).trimEnd();
}
