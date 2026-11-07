import { posix, win32 } from "node:path";
import { expect, it } from "vitest";
import { plainRelativePath, projectRelativePath } from "./project-relative-path.js";
const candidates = [
    "Content/Maps/Level.umap",
    "Content/Ünïcode/名前.uasset",
    "Content/trailing dot./Space .uasset",
    "Plugins/Feature/Content/A.uasset",
    "Content//Double.uasset",
    "./Content/A.uasset",
    "Content/../Escape.uasset",
    "/Absolute/Content.uasset",
    "C:/Drive/Content.uasset",
    "Content\\Back\\Slash.uasset",
    "Content/A.uasset/",
    "Content/a:b.uasset",
    ""
];
it("matches resolve-then-relative for plain paths on POSIX and Windows", () => {
    for (const path of candidates.filter(plainRelativePath)) {
        expect(projectRelativePath("/project/root", path, "/")).toBe(posix.relative("/project/root", posix.resolve("/project/root", path)));
        expect(projectRelativePath("D:\\Project", path, "\\")).toBe(win32.relative("D:\\Project", win32.resolve("D:\\Project", path)));
    }
    expect(candidates.filter(plainRelativePath)).toEqual(candidates.slice(0, 4));
});
