// Gather-only (Plan 060). Wrappers around text macros, defined in a header so that Unreal's
// nested-macro prepass applies them to every file it gathers. Nothing includes this header.
// A wrapper whose body holds NSLOCTEXT also registers as a LOCTEXT wrapper ("LOCTEXT" is a
// substring of "NSLOCTEXT"). The two same-named descriptors then defer to each other at every
// call, so Unreal never gathers UE_SHED_HARBOR_TEXT's text.

#pragma once

#define UE_SHED_HARBOR_TEXT(Key, Text) NSLOCTEXT("UnrealSource.Harbor", Key, Text)

#define UE_SHED_HARBOR_PARAM(Name, Text) \
	static const FText Name##Label = LOCTEXT(#Name "Label", Text);

#define UE_SHED_HARBOR_COMMAND(Name, Label, Tip) \
	UI_COMMAND(Name, Label, Tip, EUserInterfaceActionType::Button, FInputChord())
