# Editor foreground responsiveness

Unreal throttles a background editor to about 3 frames a second, so each Remote Control request
to it waits about a third of a second. This capability lets a local client keep the editor at full
speed only while that client owns the foreground window.

On Windows, `UEShedCoreEditor` advertises `editor.foreground-responsiveness.v1` and a
`foregroundResponsivenessObjectPath` in the Core capability manifest. Other platforms do not
advertise it, and calls there return `unsupported`.

## Calls

Invoke `UpdateForegroundLease` with `RequestJson` matching `foreground-lease-request.schema.json`
and decode `ResultJson` with `foreground-lease-result.schema.json`. Invoke
`GetForegroundResponsivenessState` with `foreground-state-request.schema.json` for diagnostics; the
result matches `foreground-state-result.schema.json`.

Every request carries `expectedProcessId`, the editor process ID from the manifest identity. A
stale identity is rejected with `target_changed`. Lease requests also carry `clientProcessId`: the
process whose foreground window should keep the editor responsive.

| Operation | Request                                | Success                                         |
| --------- | -------------------------------------- | ----------------------------------------------- |
| `acquire` | `clientProcessId`, optional `ttlMs`    | `granted` with `leaseId`, `ttlMs`               |
| `renew`   | `clientProcessId`, `leaseId`, `ttlMs`? | `renewed` with the new `ttlMs`                  |
| `release` | `clientProcessId`, `leaseId`           | `released` (also for an unknown or ended lease) |

`ttlMs` is 2,000–30,000 and defaults to 5,000. Renew at about a third of the TTL so one lost
renewal does not end the lease. An editor holds at most 8 leases.

## Statuses

| Status        | Reasons                                                                                                   | Caller action                                   |
| ------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `granted`     | none                                                                                                      | Renew before `ttlMs` passes.                    |
| `renewed`     | none                                                                                                      | Keep renewing.                                  |
| `released`    | none                                                                                                      | Nothing.                                        |
| `expired`     | `lease_ended` (TTL passed or never granted), `client_exited`, `client_changed` (process ID reused)        | Acquire again if still wanted.                  |
| `rejected`    | `invalid_request`, `target_changed`, `own_process`, `client_unavailable`, `lease_limit`, `lease_mismatch` | Fix the request, reconnect, or release a lease. |
| `unsupported` | `platform`, `editor_unavailable`                                                                          | Unreal's normal policy applies; do not retry.   |

## What it does

The editor registers one entry in `UEditorEngine::ShouldDisableCPUThrottlingDelegates` and removes
only that entry on shutdown. The entry returns true only when an unexpired lease's client process
is alive and owns the foreground window (`GetForegroundWindow`, then `GetWindowThreadProcessId`).
Unreal asks this before its own foreground, minimised and setting checks, so a true answer keeps
the editor responsive even when it is minimised or the user's "Use Less CPU when in Background"
setting is on. A false answer defers to Unreal's normal policy; it never forces throttling, and
other exemptions still apply.

The editor checks the foreground on each throttle decision, so a client does not send a request
when it gains or loses focus. While throttled, the first request after the client comes to the
foreground still waits for the rest of the current throttled frame.

The editor opens the client process with `SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION` only and
holds that handle until the lease is released, expires, or the editor shuts down. Holding it keeps
the process ID from being reused; the process creation time is also bound at grant and checked on
renew. The editor's own process is refused.

## What it never does

- Change or save the user's editor settings or any config. The state report reads the throttle
  setting and nothing else.
- Activate, restore, or focus any window.
- Remove or override other plugins' or the engine's throttle exemptions.
- Grant an exemption to a remote client. Clients must call it only for a loopback endpoint; a
  remote editor's foreground is a different machine's desktop.

Command-line hosts are not supported yet: a terminal, not the host process, owns the console's
foreground window.
