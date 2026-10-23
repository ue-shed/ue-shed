// Unreal ICU 64 required-category facts, ported with the format grammar.
pub const CARDINAL: &[(&[&str], &str)] = &[
    (&["few", "many", "one", "other"], "be cs lt mt pl ru sk uk"),
    (&["few", "many", "one", "other", "two"], "br ga gv"),
    (
        &["few", "many", "one", "other", "two", "zero"],
        "ar ars cy kw",
    ),
    (&["few", "one", "other"], "bs hr mo ro sh shi sr"),
    (&["few", "one", "other", "two"], "dsb gd hsb sl"),
    (&["many", "one", "other", "two"], "he iw"),
    (
        &["one", "other"],
        "af ak am as asa ast az bem bez bg bh bn brx ca ce ceb cgg chr ckb da de dv ee el en eo es et eu fa ff fi fil fo fr fur fy gl gsw gu guw ha haw hi hu hy ia io is it jgo ji jmc ka kab kaj kcg kk kkj kl kn ks ksb ku ky lb lg ln mas mg mgo mk ml mn mr nah nb nd ne nl nn nnh no nr nso ny nyn om or os pa pap ps pt pt_PT rm rof rwk saq sc scn sd sdh seh si sn so sq ss ssy st sv sw syr ta te teo ti tig tk tl tn tr ts tzm ug ur uz ve vo vun wa wae xh xog yi zu",
    ),
    (&["one", "other", "two"], "iu naq se sma smi smj smn sms"),
    (&["one", "other", "zero"], "ksh lag lv prg"),
    (
        &["other"],
        "bm bo dz id ig ii in ja jbo jv jw kde kea km ko lkt lo ms my nqo sah ses sg th to vi wo yo yue zh",
    ),
];
pub const ORDINAL: &[(&[&str], &str)] = &[
    (&["few", "many", "one", "other"], "az"),
    (&["few", "many", "one", "other", "two"], "as bn gu hi or"),
    (&["few", "many", "one", "other", "two", "zero"], "cy"),
    (&["few", "one", "other", "two"], "ca en gd mr"),
    (&["few", "other"], "be tk uk"),
    (&["many", "one", "other"], "ka kw sq"),
    (&["many", "one", "other", "two"], "mk"),
    (&["many", "other"], "it kk sc scn"),
    (&["one", "other"], "fil fr ga hu hy lo mo ms ne ro sv tl vi"),
    (
        &["other"],
        "af am ar bg bs ce cs da de dsb el es et eu fa fi fy gl gsw he hr hsb ia id in is iw ja km kn ko ky lt lv ml mn my nb nl pa pl prg ps pt ru sd sh si sk sl sr sw ta te th tr ur uz yue zh zu",
    ),
];
