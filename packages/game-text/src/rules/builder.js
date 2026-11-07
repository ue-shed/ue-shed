import { Predicate } from "effect";
export const asExpr = (value) => (Predicate.isObject(value) ? value : { lit: value });
const e = asExpr;
/** An aggregate's named arguments. */
const named = (args) => Object.fromEntries(Object.entries(args).map(([name, value]) => [name, e(value)]));
/** Construct one rule without evaluating or changing its expressions. */
export const rule = (definition) => definition;
/** Typed JSON constructors; no computation or policy runs in the builder. */
export const expr = {
    field: (name) => ({ field: name }),
    param: (name) => ({ param: name }),
    var: (name) => ({ var: name }),
    finding: (name) => ({ finding: name }),
    lit: (value) => ({ lit: value }),
    list: (...values) => ({ list: values.map(e) }),
    object: (fields) => ({
        object: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, e(value)]))
    }),
    occurrences: () => ({ occurrences: [] }),
    not: (value) => ({ not: e(value) }),
    isNull: (value) => ({ isNull: e(value) }),
    utf16Length: (value) => ({ utf16Length: e(value) }),
    codePoints: (value) => ({ codePoints: e(value) }),
    visibleLength: (value) => ({ visibleLength: e(value) }),
    visibleWords: (value) => ({ visibleWords: e(value) }),
    interiorLineBreaks: (value) => ({ interiorLineBreaks: e(value) }),
    trim: (value) => ({ trim: e(value) }),
    lower: (value) => ({ lower: e(value) }),
    normalizeLineEndings: (value) => ({ normalizeLineEndings: e(value) }),
    count: (value) => ({ count: e(value) }),
    flatten: (value) => ({ flatten: e(value) }),
    distinct: (value) => ({ distinct: e(value) }),
    first: (value) => ({ first: e(value) }),
    sortByStart: (value) => ({ sortByStart: e(value) }),
    formatArgumentNames: (value) => ({ formatArgumentNames: e(value) }),
    formatArgumentOrder: (value) => ({ formatArgumentOrder: e(value) }),
    formatModifiers: (value) => ({ formatModifiers: e(value) }),
    formatIssues: (value) => ({ formatIssues: e(value) }),
    formatCompiled: (value) => ({ formatCompiled: e(value) }),
    richTextCounts: (value) => ({ richTextCounts: e(value) }),
    richTextTagBalance: (value) => ({ richTextTagBalance: e(value) }),
    unrealWhitespace: (value) => ({ unrealWhitespace: e(value) }),
    unrealUnsafeWhitespace: (value) => ({ unrealUnsafeWhitespace: e(value) }),
    formatBraceBalance: (value) => ({ formatBraceBalance: e(value) }),
    maxOf: (value) => ({ maxOf: e(value) }),
    get: (a, b) => ({ get: [e(a), e(b)] }),
    eq: (a, b) => ({ eq: [e(a), e(b)] }),
    ne: (a, b) => ({ ne: [e(a), e(b)] }),
    lt: (a, b) => ({ lt: [e(a), e(b)] }),
    le: (a, b) => ({ le: [e(a), e(b)] }),
    gt: (a, b) => ({ gt: [e(a), e(b)] }),
    ge: (a, b) => ({ ge: [e(a), e(b)] }),
    in: (a, b) => ({ in: [e(a), e(b)] }),
    sub: (a, b) => ({ sub: [e(a), e(b)] }),
    div: (a, b) => ({ div: [e(a), e(b)] }),
    round: (a, b) => ({ round: [e(a), e(b)] }),
    startsWith: (a, b) => ({ startsWith: [e(a), e(b)] }),
    endsWith: (a, b) => ({ endsWith: [e(a), e(b)] }),
    contains: (a, b) => ({ contains: [e(a), e(b)] }),
    countOccurrences: (a, b) => ({ countOccurrences: [e(a), e(b)] }),
    findAll: (a, b) => ({ findAll: [e(a), e(b)] }),
    anyChar: (a, b) => ({ anyChar: [e(a), e(b)] }),
    allChars: (a, b) => ({ allChars: [e(a), e(b)] }),
    removeClass: (a, b) => ({ removeClass: [e(a), e(b)] }),
    leadingClass: (a, b) => ({ leadingClass: [e(a), e(b)] }),
    trailingClass: (a, b) => ({ trailingClass: [e(a), e(b)] }),
    take: (a, b) => ({ take: [e(a), e(b)] }),
    drop: (a, b) => ({ drop: [e(a), e(b)] }),
    minus: (a, b) => ({ minus: [e(a), e(b)] }),
    zip: (a, b) => ({ zip: [e(a), e(b)] }),
    matchesRole: (a, b) => ({ matchesRole: [e(a), e(b)] }),
    pathHasPrefix: (a, b) => ({ pathHasPrefix: [e(a), e(b)] }),
    formatPattern: (a, b) => ({ formatPattern: [e(a), e(b)] }),
    richTextValid: (a, b) => ({ richTextValid: [e(a), e(b)] }),
    compareRichTextTags: (a, b) => ({ compareRichTextTags: [e(a), e(b)] }),
    withoutOptionalArgumentTags: (a, b) => ({
        withoutOptionalArgumentTags: [e(a), e(b)]
    }),
    findingField: (rule, path) => ({ findingField: [rule, path] }),
    if: (a, b, c) => ({ if: [e(a), e(b), e(c)] }),
    slice: (a, b, c) => ({ slice: [e(a), e(b), e(c)] }),
    trimClass: (a, b, c) => ({ trimClass: [e(a), e(b), e(c)] }),
    runs: (a, b, c) => ({ runs: [e(a), e(b), e(c)] }),
    regexMatches: (a, b, c) => ({ regexMatches: [e(a), e(b), e(c)] }),
    regexTest: (a, b, c) => ({ regexTest: [e(a), e(b), e(c)] }),
    termMatches: (a, b, c) => ({ termMatches: [e(a), e(b), e(c)] }),
    regexReplace: (a, b, c) => ({ regexReplace: [e(a), e(b), e(c)] }),
    and: (...values) => ({ and: values.map(e) }),
    or: (...values) => ({ or: values.map(e) }),
    coalesce: (...values) => ({ coalesce: values.map(e) }),
    add: (...values) => ({ add: values.map(e) }),
    mul: (...values) => ({ mul: values.map(e) }),
    min: (...values) => ({ min: values.map(e) }),
    max: (...values) => ({ max: values.map(e) }),
    concat: (...values) => ({ concat: values.map(e) }),
    concatLists: (...values) => ({ concatLists: values.map(e) }),
    filter: (list, body, name) => ({
        filter: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
    }),
    map: (list, body, name) => ({
        map: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
    }),
    flatMap: (list, body, name) => ({
        flatMap: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
    }),
    any: (list, body, name) => ({
        any: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
    }),
    all: (list, body, name) => ({
        all: name === undefined ? [e(list), e(body)] : [e(list), e(body), name]
    }),
    sortCodeUnit: (list, by) => ({
        sortCodeUnit: by === undefined ? [e(list)] : [e(list), e(by)]
    }),
    sortLocale: (list, by) => ({
        sortLocale: by === undefined ? [e(list)] : [e(list), e(by)]
    }),
    termListMatches: (a, b, c, d) => ({
        termListMatches: [e(a), e(b), e(c), e(d)]
    }),
    formatRenameArgument: (a, b, c, d) => ({
        formatRenameArgument: [e(a), e(b), e(c), e(d)]
    }),
    groupCount: (args) => ({ groupCount: named(args) }),
    groupRank: (args) => ({ groupRank: named(args) }),
    groupTake: (args) => ({
        groupTake: named(args)
    }),
    groupTally: (args) => ({
        groupTally: named(args)
    }),
    existsOther: (args) => ({
        existsOther: named(args)
    }),
    /** Counts `corpus_occurrence` rows, the only corpus relation. */
    corpusCount: (args) => ({
        corpusCount: named({ relation: "corpus_occurrence", ...args })
    })
};
