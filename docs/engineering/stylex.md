# StyleX

Use StyleX for first-party UI styles.

Extensions own local styles. Shared packages keep them visually consistent:

```text
@ue-shed/ui-theme -> tokens and themes
@ue-shed/ui       -> Solid primitives and StyleX adapter
extension         -> local product styles
host              -> theme selection
```

## Rules

- Use semantic tokens for color, spacing, type, radius, density, and motion.
- Share StyleX variables, not class names or CSS variable strings.
- Keep styles next to their component.
- Apply a class to each styled element.
- Do not couple extensions through global, child, or sibling selectors.
- Hosts choose themes. They do not patch extensions with CSS overrides.
- Limit style props when a component must protect layout, focus, or hit targets.
- Keep global CSS to a small reset and document boundary.
- Prove StyleX compilation in every app and extension build.

Spread `stylex.attrs(...)` onto Solid DOM elements. It emits HTML `class` and serialized inline
styles, which work with Solid 2 on both HTML and SVG. `stylex.props(...)` emits React's `className`
and must not be spread onto Solid 2 elements.

## Checks

Use types and StyleX lint/compiler checks. Test variants, themes, focus, disabled state, and style
merging. Use visual tests for key components and product screens. Do not snapshot generated class
names or atomic CSS as the main contract.
