# Engineering

UE Shed code should be functional, typed, observable, and well tested.

## Rules

1. Keep domain logic pure. Use Effect at system edges.
2. Use Effect Schema by default. Infer types and derive schema variants from it.
3. Use branded IDs and unions that rule out invalid states.
4. Return typed, useful errors for expected failures.
5. Scope resources. Bound queues, retries, and stored data.
6. Add traces, metrics, health, and clear diagnostics.
7. Test each behavior at the lowest layer that can prove it.
8. Prefer real local systems and the Unreal fixture over broad mocks.
9. Keep Solid views thin and StyleX styles local.
10. Keep every feature usable without Workbench.

## Guides

| Guide                                     | Use it for                                |
| ----------------------------------------- | ----------------------------------------- |
| [Functional design](functional-design.md) | Logic, state, services, and concurrency   |
| [Types and errors](types-and-errors.md)   | Schemas, IDs, APIs, and failures          |
| [Effect](effect.md)                       | Services, resources, streams, and retries |
| [SolidJS](solidjs.md)                     | First-party UI code                       |
| [StyleX](stylex.md)                       | Styles, themes, and UI packages           |
| [Observability](observability.md)         | Telemetry, health, and diagnostics        |
| [Testing](testing.md)                     | Test scope and test types                 |

## Stack

TypeScript for public code. Effect for app behavior. SolidJS for first-party UI. StyleX for styles.
C++ for small Unreal-side features.
