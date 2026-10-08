// Required-category facts verified against the identical ICU 64 data in UE 5.7 and 5.8.
// These tables describe categories, not plural-selection expressions. Host ICU is not consulted.
import type { CultureCode } from "@ue-shed/localization/browser";

const cardinal = [
	{ forms: ["few", "many", "one", "other"], languages: "be cs lt mt pl ru sk uk".split(" ") },
	{ forms: ["few", "many", "one", "other", "two"], languages: "br ga gv".split(" ") },
	{ forms: ["few", "many", "one", "other", "two", "zero"], languages: "ar ars cy kw".split(" ") },
	{ forms: ["few", "one", "other"], languages: "bs hr mo ro sh shi sr".split(" ") },
	{ forms: ["few", "one", "other", "two"], languages: "dsb gd hsb sl".split(" ") },
	{ forms: ["many", "one", "other", "two"], languages: "he iw".split(" ") },
	{
		forms: ["one", "other"],
		languages:
			"af ak am as asa ast az bem bez bg bh bn brx ca ce ceb cgg chr ckb da de dv ee el en eo es et eu fa ff fi fil fo fr fur fy gl gsw gu guw ha haw hi hu hy ia io is it jgo ji jmc ka kab kaj kcg kk kkj kl kn ks ksb ku ky lb lg ln mas mg mgo mk ml mn mr nah nb nd ne nl nn nnh no nr nso ny nyn om or os pa pap ps pt pt_PT rm rof rwk saq sc scn sd sdh seh si sn so sq ss ssy st sv sw syr ta te teo ti tig tk tl tn tr ts tzm ug ur uz ve vo vun wa wae xh xog yi zu".split(
				" "
			)
	},
	{ forms: ["one", "other", "two"], languages: "iu naq se sma smi smj smn sms".split(" ") },
	{ forms: ["one", "other", "zero"], languages: "ksh lag lv prg".split(" ") },
	{
		forms: ["other"],
		languages:
			"bm bo dz id ig ii in ja jbo jv jw kde kea km ko lkt lo ms my nqo sah ses sg th to vi wo yo yue zh".split(
				" "
			)
	}
];
const ordinal = [
	{ forms: ["few", "many", "one", "other"], languages: "az".split(" ") },
	{ forms: ["few", "many", "one", "other", "two"], languages: "as bn gu hi or".split(" ") },
	{ forms: ["few", "many", "one", "other", "two", "zero"], languages: "cy".split(" ") },
	{ forms: ["few", "one", "other", "two"], languages: "ca en gd mr".split(" ") },
	{ forms: ["few", "other"], languages: "be tk uk".split(" ") },
	{ forms: ["many", "one", "other"], languages: "ka kw sq".split(" ") },
	{ forms: ["many", "one", "other", "two"], languages: "mk".split(" ") },
	{ forms: ["many", "other"], languages: "it kk sc scn".split(" ") },
	{ forms: ["one", "other"], languages: "fil fr ga hu hy lo mo ms ne ro sv tl vi".split(" ") },
	{
		forms: ["other"],
		languages:
			"af am ar bg bs ce cs da de dsb el es et eu fa fi fy gl gsw he hr hsb ia id in is iw ja km kn ko ky lt lv ml mn my nb nl pa pl prg ps pt ru sd sh si sk sl sr sw ta te th tr ur uz yue zh zu".split(
				" "
			)
	}
];

export function unrealPluralForms(
	culture: CultureCode,
	type: "cardinal" | "ordinal"
): readonly string[] | undefined {
	const language = culture.replaceAll("_", "-").split("-")[0]?.toLowerCase();
	if (language === undefined || !cardinal.some((group) => group.languages.includes(language)))
		return undefined;
	return (
		(type === "cardinal" ? cardinal : ordinal).find((group) =>
			group.languages.includes(language)
		)?.forms ?? ["other"]
	);
}
