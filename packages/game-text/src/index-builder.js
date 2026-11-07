import { Context } from "effect";
/** Native build capability. The builder supplies one leased index across all input and join operations; queries acquire their own immutable native reader.
 */
export class GameTextIndexBuilder extends Context.Service()("@ue-shed/game-text/GameTextIndexBuilder") {
}
