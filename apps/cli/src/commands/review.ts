import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import {
	runReviewAuthoring,
	runReviewCapture,
	runReviewFraming,
	runReviewHistory,
	runReviewPolicies,
	runReviewSetValidate,
	runReviewShow,
	runReviewViewPut
} from "../workflows/review.js";
import { optionalFlag, optionalValue } from "./options.js";

const reviewSetValidateCommand = Command.make(
	"validate",
	{ reviewSetPath: Argument.string("review-set") },
	({ reviewSetPath }) => runReviewSetValidate({ _tag: "ReviewSetValidate", reviewSetPath })
).pipe(Command.withDescription("Validate a Review Set document."));

const reviewPoliciesListCommand = Command.make(
	"list",
	{ reviewSetPath: Argument.string("review-set") },
	({ reviewSetPath }) => runReviewPolicies({ _tag: "ReviewPoliciesList", reviewSetPath })
).pipe(Command.withDescription("Validate and list Visibility Policies and View overrides."));

const reviewPoliciesReplaceCommand = Command.make(
	"replace",
	{
		reviewSetPath: Argument.string("review-set"),
		viewId: Argument.string("view-id"),
		policyPath: Argument.string("policy-json"),
		overridesPath: optionalFlag("overrides")
	},
	({ reviewSetPath, viewId, policyPath, overridesPath }) => {
		const overrides = optionalValue(overridesPath);
		return runReviewPolicies({
			_tag: "ReviewPoliciesReplace",
			policyPath,
			reviewSetPath,
			viewId,
			...(overrides === undefined ? {} : { overridesPath: overrides })
		});
	}
).pipe(
	Command.withDescription(
		"Create an immutable policy preset and assign it to exactly one Review View."
	)
);

const reviewPoliciesApplyCommand = Command.make(
	"apply",
	{
		reviewSetPath: Argument.string("review-set"),
		policyId: Argument.string("policy-id"),
		viewIds: Argument.string("view-id").pipe(Argument.variadic({ min: 1 }))
	},
	({ reviewSetPath, policyId, viewIds }) =>
		runReviewPolicies({
			_tag: "ReviewPoliciesApply",
			policyId,
			reviewSetPath,
			viewIds
		})
).pipe(Command.withDescription("Apply an existing policy preset to selected Review Views."));

const reviewViewPutCommand = Command.make(
	"put",
	{
		reviewSetPath: Argument.string("review-set"),
		viewPath: Argument.string("view-json")
	},
	({ reviewSetPath, viewPath }) =>
		runReviewViewPut({ _tag: "ReviewViewPut", reviewSetPath, viewPath })
).pipe(
	Command.withDescription(
		"Create or revise a fixed actor, target-relative actor, or fixed area Review View."
	)
);

const reviewFramingCandidatesCommand = Command.make(
	"candidates",
	{ endpoint: Argument.string("endpoint"), parametersPath: optionalFlag("parameters") },
	({ endpoint, parametersPath }) => {
		const parameters = optionalValue(parametersPath);
		return runReviewFraming({
			_tag: "ReviewFramingCandidates",
			endpoint,
			...(parameters === undefined ? {} : { parametersPath: parameters })
		});
	}
).pipe(Command.withDescription("List live framing candidates."));

const reviewFramingApproveCommand = Command.make(
	"approve",
	{
		reviewSetPath: Argument.string("review-set"),
		endpoint: Argument.string("endpoint"),
		viewId: Argument.string("view-id"),
		candidateId: Argument.string("candidate-id"),
		parametersPath: optionalFlag("parameters")
	},
	({ reviewSetPath, endpoint, viewId, candidateId, parametersPath }) => {
		const parameters = optionalValue(parametersPath);
		return runReviewFraming({
			_tag: "ReviewFramingApprove",
			candidateId,
			endpoint,
			...(parameters === undefined ? {} : { parametersPath: parameters }),
			reviewSetPath,
			viewId
		});
	}
).pipe(Command.withDescription("Approve a live framing candidate."));

const reviewAuthoringBootstrapCommand = Command.make(
	"bootstrap",
	{ projectRoot: Argument.string("project-root"), endpoint: Argument.string("endpoint") },
	({ projectRoot, endpoint }) =>
		runReviewAuthoring({ _tag: "ReviewAuthoringBootstrap", endpoint, projectRoot })
).pipe(Command.withDescription("Bootstrap a Review authoring session."));

const reviewAuthoringStartCommand = Command.make(
	"start",
	{
		projectRoot: Argument.string("project-root"),
		reviewSetPath: Argument.string("review-set"),
		endpoint: Argument.string("endpoint"),
		viewId: Argument.string("view-id")
	},
	({ projectRoot, reviewSetPath, endpoint, viewId }) =>
		runReviewAuthoring({
			_tag: "ReviewAuthoringStart",
			endpoint,
			projectRoot,
			reviewSetPath,
			viewId
		})
).pipe(Command.withDescription("Start Review authoring for one View."));

const reviewAuthoringTuneCommand = Command.make(
	"tune",
	{
		projectRoot: Argument.string("project-root"),
		sessionId: Argument.string("session-id"),
		patchPath: Argument.string("patch-json")
	},
	({ projectRoot, sessionId, patchPath }) =>
		runReviewAuthoring({
			_tag: "ReviewAuthoringTune",
			patchPath,
			projectRoot,
			sessionId
		})
).pipe(Command.withDescription("Regenerate a session from framing parameters and overrides."));

function makeReviewAuthoringLocalCommand(action: "show" | "discard") {
	return Command.make(
		action,
		{
			projectRoot: Argument.string("project-root"),
			sessionId: Argument.string("session-id")
		},
		({ projectRoot, sessionId }) =>
			action === "show"
				? runReviewAuthoring({ _tag: "ReviewAuthoringShow", projectRoot, sessionId })
				: runReviewAuthoring({ _tag: "ReviewAuthoringDiscard", projectRoot, sessionId })
	).pipe(Command.withDescription(`Run Review authoring ${action}.`));
}

function makeReviewAuthoringLiveCommand(action: "resume" | "reframe" | "approve") {
	return Command.make(
		action,
		{
			projectRoot: Argument.string("project-root"),
			sessionId: Argument.string("session-id"),
			endpoint: Argument.string("endpoint")
		},
		({ projectRoot, sessionId, endpoint }) => {
			const fields = { endpoint, projectRoot, sessionId };
			return action === "resume"
				? runReviewAuthoring({ _tag: "ReviewAuthoringResume", ...fields })
				: action === "reframe"
					? runReviewAuthoring({ _tag: "ReviewAuthoringReframe", ...fields })
					: runReviewAuthoring({ _tag: "ReviewAuthoringApprove", ...fields });
		}
	).pipe(Command.withDescription(`Run Review authoring ${action}.`));
}

const reviewCaptureCommand = Command.make(
	"capture",
	{
		projectRoot: Argument.string("project-root"),
		reviewSetPath: Argument.string("review-set"),
		endpoint: Argument.string("endpoint"),
		cause: Flag.choice("cause", ["external_automation"]).pipe(Flag.optional),
		correlationId: optionalFlag("correlation")
	},
	({ projectRoot, reviewSetPath, endpoint, cause, correlationId }) => {
		const causeValue = optionalValue(cause);
		const correlationValue = optionalValue(correlationId);
		if (correlationValue !== undefined && causeValue === undefined) {
			return Effect.fail(
				new CliCommandError({
					message: "review capture --correlation requires --cause external_automation"
				})
			);
		}
		return runReviewCapture({
			_tag: "ReviewCapture",
			endpoint,
			projectRoot,
			reviewSetPath,
			...(causeValue === undefined ? {} : { cause: causeValue }),
			...(correlationValue === undefined ? {} : { correlationId: correlationValue })
		});
	}
).pipe(Command.withDescription("Capture a Review Set run."));

const reviewHistoryCommand = Command.make(
	"history",
	{ projectRoot: Argument.string("project-root") },
	({ projectRoot }) => runReviewHistory({ _tag: "ReviewHistory", projectRoot })
).pipe(Command.withDescription("List local Review capture history."));

const reviewShowCommand = Command.make(
	"show",
	{ runPath: Argument.string("run-json") },
	({ runPath }) => runReviewShow({ _tag: "ReviewShow", runPath })
).pipe(Command.withDescription("Show one Review capture run."));

export const reviewCommand = Command.make("review").pipe(
	Command.withDescription("Author and inspect Map Review evidence."),
	Command.withSubcommands([
		Command.make("sets").pipe(
			Command.withDescription("Validate Review Set documents."),
			Command.withSubcommands([reviewSetValidateCommand])
		),
		Command.make("policies").pipe(
			Command.withDescription("Inspect and assign immutable Visibility Policy presets."),
			Command.withSubcommands([
				reviewPoliciesListCommand,
				reviewPoliciesReplaceCommand,
				reviewPoliciesApplyCommand
			])
		),
		Command.make("views").pipe(
			Command.withDescription("Author and revise portable Review View definitions."),
			Command.withSubcommands([reviewViewPutCommand])
		),
		Command.make("framing").pipe(
			Command.withDescription("Inspect and approve live framing."),
			Command.withSubcommands([reviewFramingCandidatesCommand, reviewFramingApproveCommand])
		),
		Command.make("authoring").pipe(
			Command.withDescription("Manage Review authoring sessions."),
			Command.withSubcommands([
				reviewAuthoringStartCommand,
				reviewAuthoringBootstrapCommand,
				reviewAuthoringTuneCommand,
				...(["show", "discard"] as const).map(makeReviewAuthoringLocalCommand),
				...(["resume", "reframe", "approve"] as const).map(makeReviewAuthoringLiveCommand)
			])
		),
		reviewCaptureCommand,
		reviewHistoryCommand,
		reviewShowCommand
	])
);
