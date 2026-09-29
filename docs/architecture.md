# Bug Triage Agent Architecture

These diagrams describe the current v1-v4 implementation. Mermaid keeps the architecture reviewable as text alongside the code.

## Activity Diagram

This is the end-to-end decision flow for triggered, resolved, and unsupported Sentry actions.

```mermaid
flowchart TD
    A[Sentry webhook] --> B[POST /webhook/sentry]
    B --> C{HMAC signature valid?}
    C -- No --> D[401 Unauthorized]
    C -- Yes --> E{Valid JSON?}
    E -- No --> F[400 Invalid JSON]
    E -- Yes --> G{Webhook action}

    G -- Unsupported --> H[200 Ignored]
    G -- Resolved --> R1[Schedule resolved-event processing]
    R1 --> R2[Send Slack closure notification]
    R1 --> R3[Send PagerDuty closure notification]
    R2 --> R4[Log resolution]
    R3 --> R4
    R4 --> R5[Resolution flow complete]

    G -- Triggered --> T1[Schedule async triage with waitUntil]
    T1 --> T2{Recent duplicate in D1?}
    T2 -- Yes --> T3[Close duplicate notification]
    T3 --> T4[Update original record as suppressed]
    T4 --> T5[Return suppressed triage result]
    T2 -- No --> T6[Fetch Sentry operational signals]
    T6 --> T7[Rank deterministic severity]
    T7 --> T8[Investigate repository in GitHub]
    T8 --> T9[Generate report with Workers AI]
    T9 --> T10{Eligible P2/P3 remediation?}
    T10 -- Yes --> T11[Create candidate branch, patch, and PR]
    T10 -- No --> T12[Skip remediation]
    T11 --> T13[Deliver Slack or PagerDuty notification]
    T12 --> T13
    T13 --> T14[Persist audit record to D1]
    T14 --> T15[Triage flow complete]

    B -. immediate 200 for valid async events .-> Q[200 OK]
```

## Sequence Diagram

The Worker acknowledges valid triggered and resolved events immediately, while `waitUntil` runs the longer workflow.

```mermaid
sequenceDiagram
    autonumber
    participant S as Sentry
    participant W as Cloudflare Worker
    participant A as Agent
    participant SA as Sentry API
    participant AI as Workers AI
    participant GH as GitHub
    participant DB as D1
    participant N as Slack / PagerDuty

    S->>W: POST /webhook/sentry + signature + payload
    W->>W: Verify signature and parse JSON

    alt Invalid signature or JSON
        W-->>S: 401 or 400
    else Unsupported action
        W-->>S: 200 Ignored
    else Triggered action
        W->>A: ctx.waitUntil(processTriggeredEvent)
        W-->>S: 200 OK
        A->>DB: Find recent open duplicate
        alt Duplicate found
            A->>N: Send duplicate suppression closure
            A->>DB: Mark original notification suppressed
        else New alert
            A->>SA: Fetch event rate and affected users
            SA-->>A: Operational signals or graceful failure
            A->>A: Rank P0-P3 and apply one-level escalation
            A->>GH: Search repository, files, commits, CODEOWNERS
            GH-->>A: Code context and ownership
            A->>AI: Generate structured triage report
            AI-->>A: Report text
            opt Eligible remediation
                A->>GH: Create branch, update file, open PR
                GH-->>A: Pull request URL and number
            end
            A->>N: Route notification by severity
            A->>DB: Save audit record
        end
    else Resolved action
        W->>A: ctx.waitUntil(processResolvedEvent)
        W-->>S: 200 OK
        A->>N: Send Slack closure notification
        A->>N: Send PagerDuty resolution notification
        A->>A: Log resolved event
        Note over A,DB: Current implementation does not update D1 for resolved events.
    end
```

## Component and Deployment Diagram

This combines component ownership with the current Cloudflare deployment boundary. External services remain outside the Worker deployment.

```mermaid
flowchart LR
    subgraph External[External systems]
        Sentry[Sentry webhook and issue API]
        GitHub[GitHub repository and pull request API]
        Slack[Slack webhook]
        PagerDuty[PagerDuty webhook]
    end

    subgraph Cloudflare[Cloudflare account]
        Worker[Cloudflare Worker\nPOST /webhook/sentry]
        Agent[Agent orchestration\ntriggered and resolved flows]
        Rules[Deterministic tools\nseverity, signals, deduplication]
        Investigation[GitHub investigation client]
        Remediation[Auto-remediation client]
        Notifications[Notification client]
        AI[Workers AI]
        DB[(D1 triage_results)]
        Secrets[Wrangler secrets and env bindings]
    end

    Sentry -->|Webhook| Worker
    Worker --> Agent
    Worker --> Secrets
    Agent --> Rules
    Agent --> Investigation
    Agent --> Remediation
    Agent --> Notifications
    Agent --> AI
    Agent --> DB
    Rules -->|Issue signal requests| Sentry
    Investigation --> GitHub
    Remediation --> GitHub
    Notifications --> Slack
    Notifications --> PagerDuty
    Secrets -. credentials .-> Worker
```

## Entity-Relationship Diagram

The durable audit record is centered on `triage_results`. `duplicateOf` is a self-reference to the original triage record; remediation is represented by fields on the triage result and an optional GitHub pull request.

```mermaid
 erDiagram
    TRIAGE_RESULT {
        string id PK
        string eventId UK
        string title
        string project
        string level
        string businessSeverity
        string culprit
        string affectedFiles
        string suggestedOwner
        string rationale
        datetime createdAt
        string notificationChannel
        string notificationStatus
        string rawPayload
        integer eventRate
        integer affectedUserCount
        string escalationReason
        string duplicateOf FK
        string resolutionStatus
        datetime resolvedAt
        boolean remediationEligible
        string remediationStatus
        string remediationPattern
        string pullRequestUrl
        integer pullRequestNumber
    }

    TRIAGE_RESULT o|--o TRIAGE_RESULT : "duplicateOf"
    TRIAGE_RESULT ||--o PULL_REQUEST : "may create"

    PULL_REQUEST {
        integer number PK
        string url
        string repository
        string status
    }
```

> Schema note: the application code reads and writes v4 fields such as `eventRate`, `affectedUserCount`, `duplicateOf`, and `resolutionStatus`. The checked-in migrations should be extended before deploying those fields to a fresh or upgraded D1 database.

## Lifecycle State Diagram

This is optional for day-to-day orientation but useful because suppression, resolution, and remediation have different state meanings.

```mermaid
stateDiagram-v2
    [*] --> Processing: valid triggered event
    Processing --> Open: new alert persisted
    Processing --> Suppressed: duplicate detected
    Processing --> Failed: processing or integration failure
    Open --> Resolved: resolved webhook handled
    Open --> Suppressed: later duplicate updates original
    Resolved --> [*]
    Suppressed --> [*]
    Failed --> [*]

    state remediation_status {
        [*] --> NotApplicable
        NotApplicable --> Skipped
        NotApplicable --> Generated: eligible pattern
        Generated --> PRCreated: GitHub PR opened
        Generated --> Failed
        PRCreated --> [*]
        Skipped --> [*]
        Failed --> [*]
    }
```

## Why These Diagrams Are Enough

- **Activity:** explains business decisions and alternate outcomes.
- **Sequence:** explains timing, asynchronous acknowledgement, and service calls.
- **Component/deployment:** explains responsibility and runtime boundaries.
- **ER:** explains the D1 audit model and duplicate relationship.
- **Lifecycle:** explains persisted status transitions that are otherwise easy to confuse.

A class diagram, use-case diagram, and separate flowchart would mostly duplicate these views. A separate deployment diagram can be added when the system introduces queues, Durable Objects, multiple Workers, or separate environments.
