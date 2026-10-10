# Shared Game Text index measurements

Plan 057 Phase 3 shared-store revision, 2026-10-10, Windows / Node 24.21.0. Retained projects:
132,606 keys / 10 cultures / 21 localization files at 1×; 1,326,060 keys / 20 cultures / 41 files
at 10×. No retained project regeneration, 1× join rebuild or 10× in-memory pipeline. Each child
runs alone with 16,384 MiB heap, 20 GB OS RSS and 1,200 seconds per stage. Cold build sums separately
supervised durable file stages; its 10× sum exceeds 20 minutes, while its largest file takes 59.17 s.
Disk is warm, without OS eviction. Reader, refresh and final compaction probes use fresh children.

**Disk decision:** 1× is 92.36 MiB. The compacted 10× probe is 883.62 MiB, but the projection retaining
Phase 2's declared dictionary widths is **1,202.12 MiB: 178.12 MiB over 1 GiB**. The target stays open.
The saved synthetic probe's repeated ID pattern leaves dictionary strings unreferenced. Its first
compaction removes 26,085,533 strings / 1,974,125,709 UTF-8 bytes (1.84 GiB), notably path and occurrence
identity variants. Crediting that pruning would understate a forecast retaining all declared widths.
Both projections also share the probe's identical invented culture strings; neither predicts real
content compression or substitutes for the Phase 5 join. The saved sections were not modified.

## Design and measurement method

One target root publishes immutable segments and independent content-keyed ID layers under the
existing writer lock. IDs remain stable through appends; compaction remaps active layers together
into a new generation. Readers keep opened handles through retirement. SHA-256's 32-bit prefix
always resolves collisions by exact string equality. First-use physical domains own shared content.

Sorted 8,192-row hash/ID pages, 20-bit/string seven-probe prefilters, same-domain-first search and
UTF-8 length bounds avoid loading the complete hash index to append. Cache ceilings are 64 MiB
for decoded hash pages, 128 MiB for prefilters and 32 MiB for string blocks. Pending segments flush
at 250,000 strings or 64 MiB of accounted UTF-8/UTF-16/container bytes. The initial 8 MiB page budget
and 16 MiB clear-all filter cache thrashed; 10× files read 7.18–11.6 GB of lookup payload. Larger
bounded caches with individual eviction remove that repeated clearing.

Independent u32 IDs preserve file-cache reuse after manifest changes. Modular delta/zigzag
encoding at zstd 1 uses sorted identity order without a manifest-row dependency. The manifest
ID layer falls from 1.34 to 0.34 MiB at 1×. Strings retain levels 3 for text/comments, 6 for identities
and 9 for paths. Importer version 4 keeps SHA-256(version, normalized options, raw content hash),
the stat fast path and before/after mutation checks. Unchanged content remains reusable alone.

Refresh compares only old/new replaced-layer IDs and accumulates an obsolete UTF-8 byte upper
bound. At both 8 MiB and 25% of total UTF-8 bytes, an exact active-layer census confirms compaction.
False candidates reset the bound. Forced steady-store compaction reclaims just 133 bytes in
26.67 s / 261.42 s at 1×/10×: small edits should append instead. Tests cover exact threshold crossing,
strings still referenced elsewhere, readers surviving unlink, interrupted publication, a killed
compaction process and dead-lock recovery. Counters retain both generations' reads and appends.

Retained read callbacks live outside producer scopes. Otherwise sibling closures retain completed
string arrays. The corrected 1× rebase samples 171 MiB heap (189 MiB with pre-GC traces), versus
722 MiB before the fix. A multiple-segment memory test guards against retaining those arrays.

The 1× joined projection replays saved Phase 2 raw sections. The 10× projection rebases the retained
synthetic width snapshot. The package proxy sums compressed occurrence and namespace/key/source
ID columns plus directory entries, with no second string store. Package headers, extra coverage
and full origins remain unimplemented. The width-preserving forecast uses the smaller post-compaction
package proxy, so it is optimistic even before those missing fields.

Compacted totals count every physical store file, current/previous roots, stat hints and the proxy.
Post-edit totals also include the inactive PO layer after restoring authored bytes. The width-preserving
forecast charges active layers and all pre-compaction string segments; including its inactive PO
would add 3.65 MiB at 10×. Replay files and reports are measurement artifacts outside the index.

Read counters cover localization bytes and actual index reads, including padding, directories,
root/stat hints and persisted verification. Filesystem metadata, discovery configuration and
temporary importer spill IO are outside these counters. Hash lookup bytes are the stored hash/
ID/fence/prefilter payload subset accessed by lookups. Heap combines sampled and pre-GC peaks;
RSS combines child samples and parent OS polls. Buffer peaks are sampled lower bounds.

## Results

### Physical string ownership

| Scale |     Domain | Unique strings | UTF-8 MiB | Strings MiB | Hash/filter MiB | Directory MiB | Total MiB |
| ----: | ---------: | -------------: | --------: | ----------: | --------------: | ------------: | --------: |
|    1× |     source |        567,082 |     72.52 |        3.11 |            4.15 |          0.04 |      7.30 |
|    1× |      paths |      2,513,224 |    103.24 |       12.60 |           18.37 |          0.10 |     31.08 |
|    1× |   comments |            208 |      0.32 |        0.01 |            0.00 |          0.00 |      0.01 |
|    1× |   identity |      1,809,684 |    250.44 |       14.42 |           13.28 |          0.14 |     27.84 |
|    1× | culture.en |          1,476 |      0.20 |        0.01 |            0.01 |          0.00 |      0.02 |
|    1× | culture.de |        129,123 |     13.82 |        0.61 |            0.94 |          0.01 |      1.56 |
|    1× | culture.fr |        129,123 |     13.82 |        0.61 |            0.94 |          0.01 |      1.56 |
|    1× | culture.es |        129,123 |     13.82 |        0.61 |            0.94 |          0.01 |      1.56 |
|    1× | culture.it |        129,123 |     13.82 |        0.61 |            0.94 |          0.01 |      1.56 |
|    1× | culture.ja |        129,123 |     13.82 |        0.61 |            0.94 |          0.01 |      1.57 |
|    1× | culture.ko |        129,123 |     13.82 |        0.61 |            0.94 |          0.01 |      1.57 |
|    1× | culture.zh |        129,123 |     13.82 |        0.61 |            0.94 |          0.01 |      1.57 |
|    1× | culture.pt |        129,123 |     13.82 |        0.61 |            0.95 |          0.01 |      1.57 |
|    1× | culture.pl |        129,123 |     13.82 |        0.61 |            0.95 |          0.01 |      1.57 |
|   10× |     source |      6,960,205 |    890.49 |       43.44 |           50.98 |          0.52 |     94.95 |
|   10× |      paths |      7,319,659 |    296.57 |       35.32 |           53.51 |          0.30 |     89.13 |
|   10× |   comments |          1,036 |      1.58 |        0.01 |            0.01 |          0.00 |      0.02 |
|   10× |   identity |     11,201,712 |   1405.92 |       74.68 |           82.10 |          0.83 |    157.61 |
|   10× | culture.en |         14,748 |      1.99 |        0.11 |            0.11 |          0.00 |      0.22 |
|   10× | culture.de |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.fr |      1,291,226 |    139.45 |        6.33 |            9.46 |          0.09 |     15.87 |
|   10× | culture.es |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.it |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.ja |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.ko |      1,291,226 |    139.45 |        6.33 |            9.46 |          0.09 |     15.87 |
|   10× | culture.zh |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.pt |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.pl |      1,291,226 |    139.45 |        6.33 |            9.46 |          0.09 |     15.87 |
|   10× | culture.nl |      1,291,226 |    139.45 |        6.33 |            9.44 |          0.09 |     15.86 |
|   10× | culture.sv |      1,291,226 |    139.45 |        6.33 |            9.44 |          0.09 |     15.86 |
|   10× | culture.da |      1,291,226 |    139.45 |        6.33 |            9.46 |          0.09 |     15.88 |
|   10× | culture.fi |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.cs |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.tr |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.uk |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.ar |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.el |      1,291,226 |    139.45 |        6.33 |            9.45 |          0.09 |     15.87 |
|   10× | culture.hu |      1,291,226 |    139.45 |        6.33 |            9.46 |          0.09 |     15.87 |
|   10× |         c0 |        672,793 |     85.39 |        5.41 |            4.93 |          0.05 |     10.39 |
|   10× |         c1 |      1,277,965 |    136.79 |        9.56 |            9.36 |          0.09 |     19.00 |

### Stored hash lookup components (MiB)

|          Component |    1× |    10× |
| -----------------: | ----: | -----: |
| Delta fingerprints | 14.73 | 126.83 |
| Global-ID pointers | 16.86 | 144.58 |
|         Prefilters | 12.71 | 109.14 |
|        Page fences |  0.00 |   0.02 |

### Retained Phase 2 dictionary widths / compacted probe

|     Domain | 1× strings before / after | 1× stored MiB before / after | 10× strings before / after | 10× stored MiB before / after |
| ---------: | ------------------------: | ---------------------------: | -------------------------: | ----------------------------: |
|     source |         567,083 / 567,082 |                  7.30 / 7.30 |      6,960,216 / 6,960,205 |                 94.94 / 94.95 |
|      paths |     2,513,224 / 2,513,224 |                31.08 / 31.08 |     25,158,150 / 7,319,659 |                292.60 / 89.13 |
|   comments |                 208 / 208 |                  0.01 / 0.01 |              2,072 / 1,036 |                   0.04 / 0.02 |
|   identity |     1,809,684 / 1,809,684 |                27.84 / 27.84 |    19,427,451 / 11,201,712 |               270.02 / 157.61 |
| culture.en |             1,476 / 1,476 |                  0.02 / 0.02 |            14,748 / 14,748 |                   0.22 / 0.22 |
| culture.de |         129,123 / 129,123 |                  1.56 / 1.56 |      1,291,226 / 1,291,226 |                 15.87 / 15.87 |
| culture.fr |         129,123 / 129,123 |                  1.56 / 1.56 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.es |         129,123 / 129,123 |                  1.56 / 1.56 |      1,291,226 / 1,291,226 |                 15.87 / 15.87 |
| culture.it |         129,123 / 129,123 |                  1.56 / 1.56 |      1,291,226 / 1,291,226 |                 15.87 / 15.87 |
| culture.ja |         129,123 / 129,123 |                  1.57 / 1.57 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.ko |         129,123 / 129,123 |                  1.57 / 1.57 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.zh |         129,123 / 129,123 |                  1.57 / 1.57 |      1,291,226 / 1,291,226 |                 15.87 / 15.87 |
| culture.pt |         129,123 / 129,123 |                  1.57 / 1.57 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.pl |         129,123 / 129,123 |                  1.57 / 1.57 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.nl |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.87 / 15.86 |
| culture.sv |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.86 / 15.86 |
| culture.da |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.88 / 15.88 |
| culture.fi |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.cs |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.87 / 15.87 |
| culture.tr |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.uk |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.ar |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.87 / 15.87 |
| culture.el |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
| culture.hu |                     0 / 0 |                  0.00 / 0.00 |      1,291,226 / 1,291,226 |                 15.88 / 15.87 |
|         c0 |                     0 / 0 |                  0.00 / 0.00 |          679,764 / 672,793 |                 10.47 / 10.39 |
|         c1 |                     0 / 0 |                  0.00 / 0.00 |      1,291,250 / 1,277,965 |                 19.19 / 19.00 |

### Every layer (MiB)

|                Layer |   1× |   10× |
| -------------------: | ---: | ----: |
|   Generated.manifest | 0.34 |  3.50 |
| en/Generated.archive | 0.34 |  3.53 |
|      en/Generated.po | 0.35 |  3.65 |
| de/Generated.archive | 0.36 |  3.75 |
|      de/Generated.po | 0.38 |  3.91 |
| fr/Generated.archive | 0.36 |  3.75 |
|      fr/Generated.po | 0.38 |  3.91 |
| es/Generated.archive | 0.36 |  3.75 |
|      es/Generated.po | 0.38 |  3.91 |
| it/Generated.archive | 0.37 |  3.75 |
|      it/Generated.po | 0.38 |  3.91 |
| ja/Generated.archive | 0.37 |  3.75 |
|      ja/Generated.po | 0.38 |  3.91 |
| ko/Generated.archive | 0.37 |  3.75 |
|      ko/Generated.po | 0.38 |  3.91 |
| zh/Generated.archive | 0.36 |  3.75 |
|      zh/Generated.po | 0.38 |  3.91 |
| pt/Generated.archive | 0.36 |  3.75 |
|      pt/Generated.po | 0.38 |  3.91 |
| pl/Generated.archive | 0.36 |  3.75 |
|      pl/Generated.po | 0.38 |  3.91 |
|               joined | 2.33 | 33.39 |
| nl/Generated.archive |    — |  3.75 |
|      nl/Generated.po |    — |  3.91 |
| sv/Generated.archive |    — |  3.75 |
|      sv/Generated.po |    — |  3.91 |
| da/Generated.archive |    — |  3.75 |
|      da/Generated.po |    — |  3.91 |
| fi/Generated.archive |    — |  3.75 |
|      fi/Generated.po |    — |  3.91 |
| cs/Generated.archive |    — |  3.75 |
|      cs/Generated.po |    — |  3.91 |
| tr/Generated.archive |    — |  3.75 |
|      tr/Generated.po |    — |  3.91 |
| uk/Generated.archive |    — |  3.75 |
|      uk/Generated.po |    — |  3.91 |
| ar/Generated.archive |    — |  3.75 |
|      ar/Generated.po |    — |  3.91 |
| el/Generated.archive |    — |  3.75 |
|      el/Generated.po |    — |  3.91 |
| hu/Generated.archive |    — |  3.75 |
|      hu/Generated.po |    — |  3.91 |

### Whole index (MiB)

|                      Component |    1× |    10× |
| -----------------------------: | ----: | -----: |
|   Shared strings + hash lookup | 80.35 | 672.84 |
|         Localization ID layers |  7.73 | 156.24 |
|                Joined ID layer |  2.33 |  33.39 |
|           Package-column proxy |  1.93 |  21.10 |
| Root publications + stat hints |  0.01 |   0.04 |
|           Other physical files |  0.00 |   0.00 |
|         Total after compaction | 92.36 | 883.62 |
|     Total after edit + restore | 92.71 | 887.27 |

### Width-preserving forecast (MiB)

|                               Component |     1× |     10× |
| --------------------------------------: | -----: | ------: |
|               Shared strings and lookup |  80.35 |  989.10 |
|                        Active ID layers |  10.06 |  191.88 |
| Package proxy (post-compaction columns) |   1.93 |   21.10 |
|          Root publications + stat hints |   0.01 |    0.05 |
|                                   Total |  92.36 | 1202.12 |
|                                  Target | 100.00 | 1024.00 |

### Every cold import

| Scale |                 File | Seconds | Authored MiB | Derived read MiB | Segment append MiB | Heap MiB | Buffers MiB | RSS MiB |
| ----: | -------------------: | ------: | -----------: | ---------------: | -----------------: | -------: | ----------: | ------: |
|    1× |   Generated.manifest |    4.13 |        85.12 |             7.02 |               4.82 |   178.56 |       64.14 |  436.51 |
|    1× | en/Generated.archive |    2.34 |        89.80 |             3.49 |               0.00 |   147.11 |       72.54 |  445.12 |
|    1× |      en/Generated.po |    2.79 |        59.61 |             5.21 |               0.02 |   150.40 |       65.54 |  433.71 |
|    1× | de/Generated.archive |    3.16 |        84.48 |             5.07 |               1.54 |   158.46 |      101.27 |  448.78 |
|    1× |      de/Generated.po |    3.28 |        56.95 |             6.81 |               0.02 |   139.00 |       75.88 |  444.16 |
|    1× | fr/Generated.archive |    3.15 |        84.48 |             6.02 |               1.54 |   162.79 |      103.50 |  459.88 |
|    1× |      fr/Generated.po |    3.23 |        56.95 |             6.82 |               0.02 |   172.62 |       84.77 |  483.34 |
|    1× | es/Generated.archive |    3.13 |        84.48 |             6.72 |               1.54 |   172.40 |       91.32 |  462.14 |
|    1× |      es/Generated.po |    3.26 |        56.95 |             6.84 |               0.02 |   172.73 |       65.30 |  448.42 |
|    1× | it/Generated.archive |    3.17 |        84.48 |             7.66 |               1.54 |   159.09 |      104.98 |  487.51 |
|    1× |      it/Generated.po |    3.24 |        56.95 |             6.86 |               0.02 |   143.40 |       67.30 |  428.28 |
|    1× | ja/Generated.archive |    3.30 |        84.48 |             8.48 |               1.54 |   152.04 |       95.64 |  458.89 |
|    1× |      ja/Generated.po |    3.22 |        56.95 |             6.87 |               0.02 |   145.14 |       66.91 |  440.46 |
|    1× | ko/Generated.archive |    3.24 |        84.48 |             9.44 |               1.55 |   162.57 |      107.79 |  477.27 |
|    1× |      ko/Generated.po |    3.28 |        56.95 |             6.88 |               0.02 |   168.24 |       83.80 |  470.18 |
|    1× | zh/Generated.archive |    3.40 |        84.48 |            10.54 |               1.55 |   155.86 |       92.84 |  467.35 |
|    1× |      zh/Generated.po |    3.19 |        56.95 |             6.89 |               0.02 |   147.28 |       70.40 |  452.64 |
|    1× | pt/Generated.archive |    3.27 |        84.48 |            11.13 |               1.55 |   180.51 |       98.29 |  484.39 |
|    1× |      pt/Generated.po |    3.24 |        56.95 |             6.92 |               0.02 |   149.31 |       77.65 |  455.67 |
|    1× | pl/Generated.archive |    3.31 |        84.48 |            12.15 |               1.55 |   173.21 |       93.96 |  481.69 |
|    1× |      pl/Generated.po |    3.28 |        56.95 |             6.93 |               0.02 |   141.23 |       67.39 |  463.21 |
|   10× |   Generated.manifest |   44.66 |       861.42 |            97.73 |              48.09 |   621.06 |      415.76 | 1248.64 |
|   10× | en/Generated.archive |   22.60 |       903.21 |            39.56 |               0.00 |   491.37 |      357.79 | 1181.55 |
|   10× |      en/Generated.po |   27.30 |       602.91 |            59.19 |               0.22 |   563.21 |      418.45 | 1179.71 |
|   10× | de/Generated.archive |   31.86 |       849.99 |            64.87 |              15.66 |   543.50 |      403.56 | 1229.42 |
|   10× |      de/Generated.po |   33.45 |       576.27 |            76.07 |               0.21 |   547.31 |      422.35 | 1199.63 |
|   10× | fr/Generated.archive |   32.65 |       849.99 |            75.79 |              15.67 |   527.83 |      404.85 | 1216.00 |
|   10× |      fr/Generated.po |   33.72 |       576.27 |            76.41 |               0.21 |   561.44 |      424.97 | 1208.57 |
|   10× | es/Generated.archive |   34.26 |       849.99 |            88.71 |              15.66 |   541.82 |      432.71 | 1262.95 |
|   10× |      es/Generated.po |   33.59 |       576.27 |            76.64 |               0.21 |   559.57 |      425.32 | 1211.48 |
|   10× | it/Generated.archive |   35.13 |       849.99 |           100.46 |              15.66 |   545.24 |      453.81 | 1257.21 |
|   10× |      it/Generated.po |   33.71 |       576.27 |            76.61 |               0.21 |   560.84 |      423.53 | 1196.17 |
|   10× | ja/Generated.archive |   36.07 |       849.99 |           112.38 |              15.67 |   532.85 |      462.10 | 1273.36 |
|   10× |      ja/Generated.po |   33.81 |       576.27 |            76.83 |               0.21 |   611.97 |      425.72 | 1221.21 |
|   10× | ko/Generated.archive |   38.40 |       849.99 |           125.35 |              15.67 |   632.01 |      457.95 | 1280.60 |
|   10× |      ko/Generated.po |   35.07 |       576.27 |            76.93 |               0.21 |   537.23 |      411.84 | 1217.75 |
|   10× | zh/Generated.archive |   38.79 |       849.99 |           137.24 |              15.66 |   457.47 |      464.03 | 1235.16 |
|   10× |      zh/Generated.po |   34.01 |       576.27 |            77.28 |               0.21 |   556.99 |      425.93 | 1227.32 |
|   10× | pt/Generated.archive |   39.93 |       849.99 |           150.60 |              15.66 |   513.59 |      444.07 | 1295.77 |
|   10× |      pt/Generated.po |   34.13 |       576.27 |            77.27 |               0.21 |   621.74 |      437.43 | 1249.92 |
|   10× | pl/Generated.archive |   50.20 |       849.99 |           182.70 |              15.67 |   648.18 |      471.64 | 1293.61 |
|   10× |      pl/Generated.po |   41.87 |       576.27 |            77.43 |               0.21 |   612.63 |      436.23 | 1246.27 |
|   10× | nl/Generated.archive |   47.39 |       849.99 |           241.64 |              15.66 |   490.33 |      442.04 | 1286.52 |
|   10× |      nl/Generated.po |   45.46 |       576.27 |            77.69 |               0.21 |   562.29 |      424.82 | 1233.55 |
|   10× | sv/Generated.archive |   46.36 |       849.99 |           302.22 |              15.65 |   473.71 |      451.78 | 1313.06 |
|   10× |      sv/Generated.po |   34.58 |       576.27 |            77.95 |               0.21 |   600.62 |      386.84 | 1207.59 |
|   10× | da/Generated.archive |   50.98 |       849.99 |           356.59 |              15.67 |   482.29 |      456.97 | 1327.10 |
|   10× |      da/Generated.po |   35.17 |       576.27 |            78.04 |               0.21 |   568.25 |      426.82 | 1236.33 |
|   10× | fi/Generated.archive |   51.15 |       849.99 |           425.36 |              15.66 |   649.05 |      450.21 | 1285.02 |
|   10× |      fi/Generated.po |   35.79 |       576.27 |            78.21 |               0.21 |   618.84 |      438.67 | 1231.30 |
|   10× | cs/Generated.archive |   49.70 |       849.99 |           492.99 |              15.66 |   491.17 |      487.47 | 1333.60 |
|   10× |      cs/Generated.po |   34.59 |       576.27 |            78.50 |               0.21 |   558.98 |      427.10 | 1238.39 |
|   10× | tr/Generated.archive |   49.99 |       849.99 |           557.36 |              15.67 |   642.48 |      463.17 | 1229.26 |
|   10× |      tr/Generated.po |   34.42 |       576.27 |            78.55 |               0.21 |   595.85 |      355.46 | 1176.36 |
|   10× | uk/Generated.archive |   53.52 |       849.99 |           624.44 |              15.66 |   606.18 |      483.24 | 1326.57 |
|   10× |      uk/Generated.po |   34.67 |       576.27 |            78.87 |               0.21 |   559.42 |      427.45 | 1235.48 |
|   10× | ar/Generated.archive |   55.87 |       849.99 |           686.48 |              15.66 |   491.09 |      477.34 | 1350.03 |
|   10× |      ar/Generated.po |   40.46 |       576.27 |            79.07 |               0.21 |   611.06 |      438.17 | 1247.81 |
|   10× | el/Generated.archive |   59.17 |       849.99 |           750.71 |              15.66 |   655.96 |      488.05 | 1310.50 |
|   10× |      el/Generated.po |   35.11 |       576.27 |            79.04 |               0.21 |   614.08 |      437.73 | 1248.05 |
|   10× | hu/Generated.archive |   56.76 |       849.99 |           819.08 |              15.67 |   593.24 |      488.63 | 1337.68 |
|   10× |      hu/Generated.po |   35.33 |       576.27 |            79.47 |               0.21 |   560.13 |      428.35 | 1241.21 |

### Operations after the joined projection exists

| Scale |            Operation |         Seconds | Authored read MiB | Derived read MiB | Segment append | Heap MiB | Buffers MiB | RSS MiB |
| ----: | -------------------: | --------------: | ----------------: | ---------------: | -------------: | -------: | ----------: | ------: |
|    1× |  Cold sum / max file |    67.61 / 4.13 |           1507.45 |           154.75 |          18.95 |   180.51 |      107.79 |  487.51 |
|    1× |      stat-hit:target |            0.11 |              0.00 |             0.23 |            0 B |    61.60 |        4.92 |  170.21 |
|    1× |   one-byte-po:target |            3.41 |             59.61 |            25.44 |          728 B |   148.40 |       88.22 |  408.34 |
|    1× | rebase-phase2-joined |           39.32 |                 0 |           130.83 |      61.41 MiB |   189.34 |      170.89 |  565.74 |
|    1× |           compaction |           26.67 |                 0 |           174.35 |      80.35 MiB |   138.51 |      173.11 |  505.14 |
|   10× |  Cold sum / max file | 1631.67 / 59.17 |          29466.57 |          7968.31 |         349.92 |   655.96 |      488.63 | 1350.03 |
|   10× |      stat-hit:target |            0.25 |              0.00 |             1.35 |            0 B |    68.44 |       10.82 |  186.39 |
|   10× |   one-byte-po:target |           39.52 |            602.91 |           124.38 |          728 B |   551.51 |      473.40 | 1190.81 |
|   10× | rebase-phase2-joined |         1037.36 |                 0 |         12656.50 |     639.18 MiB |   431.24 |      781.79 | 1767.84 |
|   10× |           compaction |          261.42 |                 0 |          1671.92 |     672.84 MiB |   166.82 |     1277.73 | 1598.39 |

### Phase 2 / shared-reader comparison (ms)

|                    Operation | Phase 2 1× | Shared 1× | Phase 2 10× | Shared 10× |
| ---------------------------: | ---------: | --------: | ----------: | ---------: |
| Directory / retained handles |      11.76 |     24.61 |       74.00 |     137.81 |
|                  Hot columns |      63.17 |     37.07 |      578.57 |     369.76 |
|                  Source bulk |      78.29 |     86.74 |      832.99 |    1179.54 |
|        Source ownership scan |     108.48 |    118.05 |     1020.12 |    1956.08 |
|            Native extra bulk |      15.26 |      1.16 |      203.28 |     146.27 |
|  Native extra ownership scan |      25.87 |      0.34 |      241.95 |     194.95 |
|                   Paths bulk |     146.51 |    167.77 |     1398.50 |     563.87 |
|         Paths ownership scan |     380.26 |    399.51 |     4124.67 |    1503.94 |
|                 Page columns |      73.67 |     39.83 |      470.89 |     453.08 |
|           Page (300 strings) |       2.39 |      4.81 |        3.43 |       5.75 |

### Fresh reader

| Scale |      Operation |      ms | Bulk raw MiB | Page read bytes | Page blocks | Heap MiB | Buffers MiB | RSS MiB |
| ----: | -------------: | ------: | -----------: | --------------: | ----------: | -------: | ----------: | ------: |
|    1× |           open |   37.07 |            — |               — |           — |    57.48 |       42.66 |  195.23 |
|    1× |  domain:source |   86.74 |        74.68 |               — |           — |    36.58 |      200.64 |  316.10 |
|    1× |    scan:source |  118.05 |            — |               — |           — |    67.82 |      134.66 |  392.76 |
|    1× | domain:culture |    1.16 |         0.20 |               — |           — |    35.82 |      106.43 |  295.94 |
|    1× |   scan:culture |    0.34 |            — |               — |           — |    37.60 |      106.01 |  296.03 |
|    1× |   domain:paths |  167.77 |       112.83 |               — |           — |    36.38 |      280.36 |  441.00 |
|    1× |     scan:paths |  399.51 |            — |               — |           — |    66.24 |      229.64 |  413.36 |
|    1× |   page-columns |   39.83 |            — |               — |           — |    39.96 |      249.54 |  429.21 |
|    1× |           page |    4.81 |            — |           93976 |           5 |    36.13 |      241.58 |  432.50 |
|   10× |           open |  369.76 |            — |               — |           — |    63.99 |      374.59 |  529.83 |
|   10× |  domain:source | 1179.54 |       917.06 |               — |           — |    42.87 |     1359.37 | 1495.02 |
|   10× |    scan:source | 1956.08 |            — |               — |           — |    74.22 |     1284.59 | 1460.16 |
|   10× | domain:culture |  146.27 |        90.01 |               — |           — |    70.16 |     1432.42 | 1599.12 |
|   10× |   scan:culture |  194.95 |            — |               — |           — |    74.16 |     1363.14 | 1554.06 |
|   10× |   domain:paths |  563.87 |       324.50 |               — |           — |    54.04 |     1749.29 | 1942.00 |
|   10× |     scan:paths | 1503.94 |            — |               — |           — |    74.18 |     1678.21 | 1976.88 |
|   10× |   page-columns |  453.08 |            — |               — |           — |    74.18 |     1909.76 | 2085.63 |
|   10× |           page |    5.75 |            — |           68988 |           4 |    43.38 |     1881.80 | 2080.16 |

### Domain timing breakdown (ms)

| Scale |  Domain |  Read | Decompress | Verify |   Copy |   Total |
| ----: | ------: | ----: | ---------: | -----: | -----: | ------: |
|    1× |  source |  1.68 |      41.77 |  23.66 |  10.13 |   86.74 |
|    1× | culture |  0.11 |       0.28 |   0.14 |   0.02 |    1.16 |
|    1× |   paths |  6.19 |      91.87 |  38.81 |  15.71 |  167.77 |
|   10× |  source | 24.88 |     614.28 | 268.35 | 183.02 | 1179.54 |
|   10× | culture |  3.30 |      76.99 |  29.94 |  27.32 |  146.27 |
|   10× |   paths | 20.78 |     262.75 | 145.89 |  96.45 |  563.87 |

### Column timing breakdown (ms)

| Scale |    Operation | Load/decompress/CRC | ID decode | Dependency validation |  Total |
| ----: | -----------: | ------------------: | --------: | --------------------: | -----: |
|    1× |  Hot columns |               22.15 |      4.73 |                  8.31 |  37.07 |
|    1× | Page columns |               14.61 |      9.80 |                 14.38 |  39.83 |
|   10× |  Hot columns |              241.86 |     43.92 |                 80.06 | 369.76 |
|   10× | Page columns |              195.78 |     88.34 |                166.99 | 453.08 |

## Interpreting the projection and reader comparison

The remaining width-preserving 10× store costs are led by paths (292.60 MiB), identities (270.02 MiB),
authored foreign cultures (301.61 MiB), source (94.94 MiB) and synthetic culture additions (29.67 MiB).
Active ID layers add 191.88 MiB, the optimistic package proxy 21.10 MiB and publications/hints 0.05 MiB.
Removing the 178.12 MiB gap requires further savings without credit for unreferenced synthetic variants.
A globally sorted paged hash index with immutable append tiers could replace repeated segment
prefilters and reduce fingerprint-delta widths while preserving IDs. Deriving composite line/
occurrence identities and paths from their constituent columns would remove their string payload
and lookup entries. These alternatives are **not implemented or measured**, so no projected saving
is promised. The full-width 1 GiB acceptance target remains unmet.

Reader `open` times cover hot columns; the comparison reports directory/handle opening separately.
The same Phase 2 hot/page columns are used. Bulk domains retain buffers cumulatively. The
1× paths load grows from 108.02 to 112.83 MiB with localization path variants. The 10× source load
grows from 746.84 to 917.06 MiB with authored localization strings alongside invented probe strings.
Additional content and many segment reads affect load/scan costs; these are physical ownership
probes, not equivalent semantic translation queries. The read/decode/CRC/copy breakdown is above.

Native translations borrowing source IDs add no second source buffer. Synthetic c10 borrows c0;
c2–c9 and c11–c19 borrow c1 content and own no additional physical segments. A complete semantic
culture search must follow those IDs; scanning only the extra owners is not a complete culture query.
The 10× paths improvement also benefits from pruning unreferenced width-probe strings.

Dependency validation initially took 571 ms versus 84 ms for ID reconstruction in the 10×
page-column probe. Indexed iteration reduces validation to 167 ms and total page-column load
to 453 ms (Phase 2: 471 ms). Final hot-column loads are 37/370 ms. A page fetches 300 strings
in 4.81/5.75 ms with 5/4 string blocks and 93,976/68,988 counted bytes. Multiple handles and owning
blocks explain the small page/directory overhead. Fresh reader heap peaks are 67.82/74.22 MiB,
within 128/256 MiB. Full scans still need Phase 6 indexes; the cold importer reaches only
22.30/18.06 MiB/s, below the 150 MiB/s target.

## Verification and retained evidence

| Final command                                                                                                                                                                                                                                                                        |                                               Passed | Failed | Skipped |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------: | -----: | ------: |
| `pnpm exec vitest run packages/game-text/src/shared-index.test.ts --maxWorkers 1`                                                                                                                                                                                                    |                                             13 tests |      0 |       0 |
| `pnpm exec vitest run packages/localization packages/game-text scripts/game-text-scale.test.ts scripts/localization-import.test.ts --maxWorkers 1`                                                                                                                                   |                                            478 tests |      0 |       4 |
| `node26 node_modules/vitest/vitest.mjs run packages/game-text/src/snapshot-format.test.ts packages/game-text/src/snapshot-file.test.ts packages/game-text/src/snapshot-store.test.ts packages/game-text/src/shared-index.test.ts scripts/localization-import.test.ts --maxWorkers 1` |                                            127 tests |      0 |       0 |
| `pnpm --filter @ue-shed/game-text build`                                                                                                                                                                                                                                             |                                              1 build |      0 |       0 |
| `pnpm run effect:architecture`                                                                                                                                                                                                                                                       |                                               1 gate |      0 |       0 |
| `pnpm exec oxfmt`, all changed files                                                                                                                                                                                                                                                 |                                             20 files |      0 |       0 |
| `pnpm run format:check`                                                                                                                                                                                                                                                              |                                  1 gate; 1,913 files |      0 |       0 |
| `pnpm run check:precommit`                                                                                                                                                                                                                                                           | 6 stages; 43 architecture tests; 4 contract packages |      0 |       0 |

The broad oracle run covers all 21 committed localization files: UE 5.7 **7/7**, UE 5.8 **7/7**,
and UE 4.27 **7/7** matched. Tiny generated scales, one-byte chunks, escapes/continuations,
late headers, limits, mutation/retry and cleanup remain covered. No retained scale project was
regenerated. Node 26 means the retained Node 26.11.1 Windows executable under
`test-results/game-text-scale/runtime`. The four skips are existing environment-gated integration tests.
Live UE 5.7 and UE 5.8/native matrix checks were not run: this revision changes storage, not an
Unreal API, parser, code generator, fixture or native integration. Full `pnpm check` was not run.

Earlier diagnostic runs had 410 passed / 64 failed / 4 skipped (a missing directory-copy offset),
then 86 passed / 1 failed (an unresolved Promise did not keep the crash child alive). Both faults
were fixed. Precommit attempts first failed four conditional-spread lint errors, then a test's
closure-assigned reader type; both were corrected. Five tuning benchmark runs were stopped
manually; no benchmark cap fired. Final
all/refresh/compact/reader commands below each passed, with zero failed stages. Extra reader
calibration probes also passed; final JSON uses the indexed validation loop.

Raw final JSON and before-compaction root metadata are retained under
`test-results/game-text-scale/shared-final4-*.json`. Before-compaction descriptors were saved
before their old root publication retired. The authored edit is restored in `finally`, then
the original content key is reused. Final benchmark commands (one run each, eight passed / zero failed):

| Selection / scale | Completed measurement stages | Failed |
| ----------------- | ---------------------------: | -----: |
| all / 1×          |                           36 |      0 |
| all / 10×         |                           55 |      0 |
| refresh / 1×      |                            3 |      0 |
| refresh / 10×     |                            3 |      0 |
| compact / 1×      |                            2 |      0 |
| compact / 10×     |                            2 |      0 |
| reader / 1×       |                           10 |      0 |
| reader / 10×      |                           10 |      0 |

```powershell
node --import tsx scripts/benchmark-localization-import.ts --mode shared --project test-results/game-text-scale/project-1x --cache test-results/game-text-scale/shared-final4-1x --output test-results/game-text-scale/shared-final4-1x.json
node --import tsx scripts/benchmark-localization-import.ts --mode shared --select refresh --project test-results/game-text-scale/project-1x --cache test-results/game-text-scale/shared-final4-1x --output test-results/game-text-scale/shared-final4-refresh-1x.json
node --import tsx scripts/benchmark-localization-import.ts --mode shared --select compact --project test-results/game-text-scale/project-1x --cache test-results/game-text-scale/shared-final4-1x --output test-results/game-text-scale/shared-final4-compact-1x.json
node --import tsx scripts/benchmark-localization-import.ts --mode shared --select reader --project test-results/game-text-scale/project-1x --cache test-results/game-text-scale/shared-final4-1x --output test-results/game-text-scale/shared-final4-reader-1x.json
node --import tsx scripts/benchmark-localization-import.ts --mode shared --project test-results/game-text-scale/project-10x-final --cache test-results/game-text-scale/shared-final4-10x --output test-results/game-text-scale/shared-final4-10x.json
node --import tsx scripts/benchmark-localization-import.ts --mode shared --select refresh --project test-results/game-text-scale/project-10x-final --cache test-results/game-text-scale/shared-final4-10x --output test-results/game-text-scale/shared-final4-refresh-10x.json
node --import tsx scripts/benchmark-localization-import.ts --mode shared --select compact --project test-results/game-text-scale/project-10x-final --cache test-results/game-text-scale/shared-final4-10x --output test-results/game-text-scale/shared-final4-compact-10x.json
node --import tsx scripts/benchmark-localization-import.ts --mode shared --select reader --project test-results/game-text-scale/project-10x-final --cache test-results/game-text-scale/shared-final4-10x --output test-results/game-text-scale/shared-final4-reader-10x.json
```
