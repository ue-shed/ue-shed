# Camera live-frame contract v1

The live path is a byte stream of fixed-size 128-byte little-endian headers followed immediately by
`payloadLength` bytes. Receivers must resynchronize on the ASCII magic `USCF`, reject unsupported
versions and dimensions, and cap payloads before allocating. A reconnect starts a new session ID;
frames from an old session are disposable.

| Offset | Type    | Field                                                |
| -----: | ------- | ---------------------------------------------------- |
|      0 | char[4] | `USCF` magic                                         |
|      4 | u16     | version (`1`)                                        |
|      6 | u16     | header length (`128`)                                |
|      8 | u32     | flags: bit 0 sRGB, bit 1 BGRA8                       |
|     12 | u32     | width                                                |
|     16 | u32     | height                                               |
|     20 | u32     | row pitch in bytes (payload is tightly packed in v1) |
|     24 | u32     | payload length                                       |
|     28 | u32     | stable fixture camera index                          |
|     32 | u64     | per-camera sequence                                  |
|     40 | f64     | Unreal world seconds at capture request              |
|     48 | f64     | producer monotonic milliseconds at capture request   |
|     56 | f64     | GPU readback latency in milliseconds                 |
|     64 | u8[16]  | producer ID                                          |
|     80 | u8[16]  | session ID                                           |
|     96 | u8[16]  | camera ID                                            |
|    112 | u32     | cumulative readback/staging drops                    |
|    116 | u32     | cumulative latest-frame transport replacements       |
|    120 | u32     | reserved, zero                                       |
|    124 | u32     | reserved, zero                                       |

The payload is top-to-bottom, tightly packed BGRA8. Live buffers are bounded and latest-frame-wins;
sequence gaps are expected and observable. The control plane owns camera listing, schedule tuning,
pause/focus, and health. This binary stream never carries durable evidence.
