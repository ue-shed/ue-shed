import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import {
	runReviewAuthoring,
	runReviewCapture,
	runReviewFraming,
	runReviewHistory,
	runReviewSetValidate,
	runReviewShow
} from "../workflows/review.js";
import { optionalFlag, optionalValue } from "./options.js";

const reviewSetValidateCommand = Command.make(
	"validate",
	{ reviewSetPath: Argument.string("review-set") },
	({ reviewSetPath }) => runReviewSetValidate({ _tag: "ReviewSetValidate", reviewSetPath })
).pipe(Command.withDescription("Validate a Review Set document."));

const reviewFramingCandidatesCommand = Command.make(
	"candidates",
	{ endpoint: Argument.string("endpoint") },
	({ endpoint }) => runReviewFraming({ _tag: "ReviewFramingCandidates", endpoint })
).pipe(Command.withDescription("List live framing candidates."));

const reviewFramingApproveCommand = Command.make(
	"approve",
	{
		reviewSetPath: Argument.string("review-set"),
		endpoint: Argument.string("endpoint"),
		viewId: Argument.string("view-id"),
		candidateId: Argument.string("candidate-id")
	},
	({ reviewSetPath, endpoint, viewId, candidateId }) =>
		runReviewFraming({
			_tag: "ReviewFramingApprove",
			candidateId,
			endpoint,
			reviewSetPath,
			viewId
		})
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
		Command.make("framing").pipe(
			Command.withDescription("Inspect and approve live framing."),
			Command.withSubcommands([reviewFramingCandidatesCommand, reviewFramingApproveCommand])
		),
		Command.make("authoring").pipe(
			Command.withDescription("Manage Review authoring sessions."),
			Command.withSubcommands([
				reviewAuthoringStartCommand,
				reviewAuthoringBootstrapCommand,
				...(["show", "discard"] as const).map(makeReviewAuthoringLocalCommand),
				...(["resume", "reframe", "approve"] as const).map(makeReviewAuthoringLiveCommand)
			])
		),
		reviewCaptureCommand,
		reviewHistoryCommand,
		reviewShowCommand
	])
);
