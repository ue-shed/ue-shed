"""Source presence/signature survey; intentionally makes no runtime support claim."""
import csv
from evidence import engine, DOCS

targets = {
    "OnObjectTransacted": ("Runtime/CoreUObject/Public/UObject/UObjectGlobals.h", "DECLARE_MULTICAST_DELEGATE_TwoParams(FOnObjectTransacted"),
    "OnObjectPropertyChanged": ("Runtime/CoreUObject/Public/UObject/UObjectGlobals.h", "DECLARE_MULTICAST_DELEGATE_TwoParams(FOnObjectPropertyChanged"),
    "OnObjectModified": ("Runtime/CoreUObject/Public/UObject/UObjectGlobals.h", "DECLARE_MULTICAST_DELEGATE_OneParam(FOnObjectModified"),
    "DataTableChanged": ("Runtime/Engine/Classes/Engine/DataTable.h", "DELEGATE(FOnDataTableChanged)"),
    "HandleDataTableChanged": ("Runtime/Engine/Classes/Engine/DataTable.h", "void HandleDataTableChanged("),
    "PostUndo": ("Editor/UnrealEd/Public/EditorUndoClient.h", "virtual void PostUndo("),
    "PostRedo": ("Editor/UnrealEd/Public/EditorUndoClient.h", "virtual void PostRedo("),
    "PackageDirtyStateChanged": ("Runtime/CoreUObject/Public/UObject/Package.h", "DECLARE_MULTICAST_DELEGATE_OneParam(FOnPackageDirtyStateChanged"),
    "PackageMarkedDirty": ("Runtime/CoreUObject/Public/UObject/Package.h", "DECLARE_MULTICAST_DELEGATE_TwoParams(FOnPackageMarkedDirty"),
    "FScopedTransaction": ("Editor/UnrealEd/Public/ScopedTransaction.h", "FScopedTransaction(const TCHAR*"),
}
with (DOCS / "evidence/T04-version-coverage.csv").open("w", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle)
    writer.writerow(["engine", "hook", "source", "line", "declaration"])
    for version in ["4.27", "5.3", "5.5", "5.6", "5.7", "5.8"]:
        for hook, (relative, pattern) in targets.items():
            path = engine(version) / "Engine/Source" / relative
            if not path.exists():
                writer.writerow([version, hook, "Engine/Source/" + relative, 0, "UNVERIFIED: source file unavailable"])
                print(version, hook, "UNVERIFIED: source file unavailable")
                continue
            matches = [(n, line.strip()) for n, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1) if pattern in line]
            for n, line in matches or [(0, "ABSENT in inspected header")]:
                writer.writerow([version, hook, "Engine/Source/" + relative, n, line])
                print(version, hook, n, line)
