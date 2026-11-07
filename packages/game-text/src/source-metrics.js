/** Longest by UTF-16 length; lexical order breaks ties independently of input order. */
export function longestSource(values) {
    let longest = "";
    for (const value of values)
        if (value.length > longest.length || (value.length === longest.length && value < longest))
            longest = value;
    return longest;
}
