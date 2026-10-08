/** The dependency ships JavaScript; this private declaration owns its small boundary contract. */
declare module "linebreak" {
	export default class LineBreaker {
		constructor(text: string);
		nextBreak(): { position: number; required: boolean } | null;
	}
}
