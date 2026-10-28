// Gather-only. UI_COMMAND gathers its name and description: namespace UICommands, or
// UICommands.<namespace> under a LOCTEXT_NAMESPACE; the description's key ends in _ToolTip.
// It needs at least five arguments and reads the first three. UI_COMMAND_EXT is offset by two.

void RegisterWithoutNamespace()
{
	UI_COMMAND(OpenHarbor, "Open Harbor", "Opens the harbor view", EUserInterfaceActionType::Button, FInputChord());
}

#define LOCTEXT_NAMESPACE "UnrealSource.Commands"

void RegisterCommands()
{
	UI_COMMAND(
		CloseHarbor,
		"Close Harbor",
		"Closes the harbor view",
		EUserInterfaceActionType::Button,
		FInputChord()
	);
	UI_COMMAND(TooFew, "Too Few", "Four arguments gather nothing", EUserInterfaceActionType::Button);
	UI_COMMAND_EXT(Context, Commands, ToggleTides, "Toggle Tides", "Shows or hides the tide table", EUserInterfaceActionType::ToggleButton, FInputChord());
}

#undef LOCTEXT_NAMESPACE
