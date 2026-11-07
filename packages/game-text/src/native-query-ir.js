const field = (name) => ({ field: name });
const item = { var: "item" };
/** A scalar field is one of the values. */
const oneOf = (name, values) => ({
    in: [field(name), { lit: values }]
});
/** A list field holds one of the values. */
const holds = (name, values) => ({
    any: [field(name), { in: [item, { lit: values }] }]
});
const is = (name, value) => ({ eq: [field(name), { lit: value }] });
const all = (tests) => (tests.length === 1 ? tests[0] : { and: tests });
const some = (tests) => (tests.length === 1 ? tests[0] : { or: tests });
/** A test that counting by `name` drops. */
const marked = (name, test) => ({ facet: [name, test] });
const under = (prefixes) => ({
    any: [
        field("paths"),
        some(prefixes.map((prefix) => ({ pathHasPrefix: [item, { lit: prefix }] })))
    ]
});
const STATES = {
    missing: "not_translated",
    to_update: "needs_update",
    not_synced: "not_synced"
};
/**
 * One pill: `is` holds when the row has one of the values, `is_not` when it has none. The facets'
 * own pills carry their mark.
 */
const pill = (clause) => {
    const test = (expr) => (clause.op === "is" ? expr : { not: expr });
    switch (clause.field) {
        case "problem":
            return marked("problems", test(holds("problems", clause.values)));
        case "finding":
            return marked("findings", test(holds("findings", clause.values)));
        case "fact":
            return marked("facts", test(holds("facts", clause.values)));
        case "origin":
            return marked("origins", test(holds("origins", clause.values)));
        case "folder":
            return marked("paths", test(under(clause.values)));
        case "asset":
            return marked("files", test(holds("files", clause.values)));
        case "audience":
            return marked("audience", test(oneOf("audience", clause.values)));
        case "asset_type":
            return marked("assetTypes", test(holds("assetTypes", clause.values)));
        case "namespace":
            return test(oneOf("namespace", clause.values));
        case "editing":
            return test(holds("editing", clause.values));
        case "notes":
            return test(oneOf("notes", clause.values.map((value) => value === "present")));
        case "translation_key":
            // Each value is a validated `JSON.stringify([namespace, key])`.
            return test(oneOf("translationKey", clause.values.map((value) => JSON.parse(value))));
        case "source":
            return test(holds("sources", clause.values));
        case "translation":
            // A culture of the scope has no translation, an old one, or one not in Unreal.
            return test({
                anyCulture: some([
                    oneOf("state", clause.values.map((value) => STATES[value])),
                    ...(clause.values.includes("not_synced") ? [is("notSynced", true)] : [])
                ])
            });
    }
};
/**
 * A search request's rows as a query selection. The capability, translator-notes and location
 * filters must hold on one place together; the counts' tabs drop their marks.
 */
export const querySelection = (request) => {
    const localization = request.localization;
    const conjuncts = (request.filter ?? []).map(pill);
    if (request.lines)
        conjuncts.push(oneOf("id", request.lines));
    if (localization?.state)
        conjuncts.push({
            anyCulture: localization.state === "not_synced"
                ? is("notSynced", true)
                : oneOf("state", [localization.state])
        });
    if (localization?.review)
        conjuncts.push({ anyCulture: holds("review", [localization.review]) });
    if (localization?.keyChanged === true)
        conjuncts.push(is("keyChanged", true));
    const place = [];
    if (request.capability !== "all")
        place.push(marked("editing", holds("editing", [
            request.capability === "source_editable" ? "editable" : "read_only"
        ])));
    if (request.withoutNotes === true)
        place.push(marked("notes", is("notes", false)));
    const where = request.where;
    if (where?.kinds)
        place.push(marked("origins", holds("origins", where.kinds)));
    if (where?.pathPrefix)
        place.push(under([where.pathPrefix]));
    if (where?.files)
        place.push(holds("files", where.files));
    if (place.length > 0)
        conjuncts.push({ anyPlace: all(place) });
    return {
        ...(localization && {
            target: localization.target,
            ...(localization.culture !== undefined && { culture: localization.culture }),
            ...(localization.cultures !== undefined && { cultures: localization.cultures })
        }),
        ...(request.findings && { findings: request.findings }),
        ...(conjuncts.length > 0 && { where: all(conjuncts) }),
        ...(request.query.length > 0 && {
            text: {
                query: request.query,
                ...(localization?.searchTranslations === true && { translations: true })
            }
        })
    };
};
/** The field each of a search request's groups is. */
const GROUP_FIELDS = {
    problem: "problems",
    folder: "paths",
    asset: "files",
    origin: "origins",
    namespace: "namespace",
    audience: "audience",
    source: "sources",
    finding: "findings"
};
/** The field each of a search request's facets counts by, and the page's name for it. */
const FACET_FIELDS = [
    ["assets", "files"],
    ["origins", "origins"],
    ["audiences", "audience"],
    ["cultures", "cultures"],
    ["assetTypes", "assetTypes"],
    ["findings", "findings"],
    ["facts", "facts"]
];
/** A search request's facets as the query's list. Cultures are counted for a target's lines. */
const queryFacets = (facets, localized) => [
    ...(facets.folder !== undefined ? [{ by: "paths", under: facets.folder }] : []),
    ...FACET_FIELDS.filter(([name]) => facets[name] === true && (name !== "cultures" || localized)).map(([, by]) => ({ by }))
];
/** The query's facets, keyed by field, under a search page's names. */
const pageFacets = (facets) => {
    const page = {};
    if (facets.paths !== undefined)
        page["folders"] = facets.paths;
    for (const [name, by] of FACET_FIELDS) {
        const value = facets[by];
        if (value !== undefined)
            page[name] = value;
    }
    return page;
};
/** The query's groups under a search page's group name. */
const pageGroups = (groups) => {
    const by = Object.entries(GROUP_FIELDS).find(([, field]) => field === groups.by)?.[0];
    return by === undefined ? groups : { ...groups, by };
};
/**
 * A search request as a query: its rows, or the open groups' first rows, and with `aggregates`
 * the counts, facets and groups.
 */
export const searchQuery = (request, aggregates) => {
    const after = request.localization ? request.localizationCursor : request.cursor;
    const group = request.group === undefined ? undefined : GROUP_FIELDS[request.group];
    const open = request.openGroups;
    return {
        selection: querySelection(request),
        parts: {
            ...(open !== undefined && group !== undefined
                ? { openGroups: { by: group, keys: open, firstRows: request.firstRows ?? 50 } }
                : {
                    rows: {
                        limit: request.pageSize,
                        ...(after !== undefined && { after }),
                        ...(group !== undefined &&
                            request.openGroup !== undefined && {
                            group: { by: group, key: request.openGroup }
                        })
                    }
                }),
            ...(aggregates && {
                counts: true,
                ...(request.facets && {
                    facets: queryFacets(request.facets, request.localization !== undefined)
                }),
                ...(group !== undefined && {
                    groups: {
                        by: group,
                        ...(request.minGroupSize !== undefined && { minSize: request.minGroupSize })
                    }
                }),
                ...(request.where?.files && { fileScope: request.where.files })
            })
        }
    };
};
/**
 * A query's answer as the page a search returns: the rows part's units and lines, and each open
 * group's rows in its page. With open groups the page's own rows are empty.
 */
export const searchPage = (request, head, rows) => {
    const target = request.localization?.target;
    const assemble = (page, units, lines) => {
        const { nextCursor, localization, facets, groups, ...counted } = page;
        const rest = {
            ...counted,
            ...(facets !== undefined && { facets: pageFacets(facets) }),
            ...(groups !== undefined && { groups: pageGroups(groups) })
        };
        const next = nextCursor === undefined ? undefined : { nextCursor };
        return target === undefined
            ? { ...rest, ...next, units }
            : { ...rest, localization: { ...(localization ?? { target }), lines, ...next }, units };
    };
    const grouped = (part) => {
        const byGroup = new Map();
        for (const { parent, ...row } of rows(part)) {
            const listed = byGroup.get(Number(parent));
            if (listed)
                listed.push(row);
            else
                byGroup.set(Number(parent), [row]);
        }
        return byGroup;
    };
    const { openGroups, ...page } = head;
    const answer = assemble(page, rows("units"), rows("lines"));
    if (openGroups === undefined)
        return answer;
    const units = grouped("groupUnits");
    const lines = grouped("groupLines");
    return {
        ...answer,
        openGroups: openGroups.map(({ nextCursor, ...group }, index) => group.rowsOmitted
            ? group
            : {
                ...group,
                page: assemble(nextCursor === undefined ? {} : { nextCursor }, units.get(index) ?? [], lines.get(index) ?? [])
            })
    };
};
