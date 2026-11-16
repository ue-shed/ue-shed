---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/uasset": minor
---

`readSavedPackageHeader` reads one package's header from a file holding only the package's first
bytes, given the size of the whole package. A host that holds only the start of a package
revision, such as one fetched from a version-control server, can learn its exports and their
classes without downloading the rest. The result is the header a header-depth scan gives for the
whole file. When the file ends before the header does, the read fails with
`PackageHeaderNeedsBytes`, naming how many leading bytes to supply next. A package size that is not
positive, or is smaller than the file, fails as `invalid_input`, a new `AssetReaderError` kind.
Scans of files on disk are unchanged: a file truncated on disk still fails as malformed. This needs
uasset-io v1.24 and its new `package_header` operation.
