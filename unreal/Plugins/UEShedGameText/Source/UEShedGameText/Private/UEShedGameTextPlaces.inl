// Included inside the action runner's anonymous namespace. Authored locations share the same
// preflight, rollback, compile, save and receipt lifecycle as ordinary FText properties.
FText PlaceText(const FPlace& Place)
{
	return Place.Pin ? Place.Pin->DefaultTextValue : Place.Property->GetPropertyValue(Place.Value);
}

bool SetPlaceText(const FPlace& Place, const FText& Text, const bool bRestore = false)
{
	if (Place.Pin)
	{
		if (bRestore) Place.Pin->DefaultTextValue = Text;
		else if (const UEdGraphSchema* Schema = Place.Pin->GetSchema()) Schema->TrySetDefaultText(*Place.Pin, Text, false);
		else return false;
		return Place.Pin->DefaultTextValue.IdenticalTo(Text);
	}
	Place.Property->SetPropertyValue(Place.Value, Text);
	return true;
}

FStringEntryState StringEntryState(UStringTable* Asset, const FString& Key)
{
	FStringEntryState State;
	State.Key = Key;
	const FStringTableConstRef Table = Asset->GetStringTable();
	State.bExists = Table->GetSourceString(FTextKey(Key), State.Source);
	if (State.bExists)
	{
		Table->EnumerateMetaData(FTextKey(Key), [&State](const FName Name, const FString& Value)
		{
			State.Metadata.Add(Name, Value);
			return true;
		});
#if ENGINE_MAJOR_VERSION > 5 || ENGINE_MINOR_VERSION >= 8
		if (const FStringTableEntryConstPtr Entry = Table->FindEntry(FTextKey(Key))) State.DevNotes = Entry->GetDevNotes();
#endif
	}
	return State;
}

void SetStringEntry(UStringTable* Asset, const FStringEntryState& State)
{
	const FStringTableRef Table = Asset->GetMutableStringTable();
	if (!State.bExists) { Table->RemoveSourceString(FTextKey(State.Key)); return; }
#if ENGINE_MAJOR_VERSION > 5 || ENGINE_MINOR_VERSION >= 8
	Table->SetSourceString(FTextKey(State.Key), State.Source, State.DevNotes);
#else
	Table->SetSourceString(FTextKey(State.Key), State.Source);
#endif
	Table->ClearMetaData(FTextKey(State.Key));
	for (const TPair<FName, FString>& Item : State.Metadata) Table->SetMetaData(FTextKey(State.Key), Item.Key, Item.Value);
}

bool ReadPlaceIdentity(const FPlace& Place, FTextIdentity& Out, FString& Why)
{
	Out = {};
	if (Place.StringTable)
	{
		Out.Namespace = Place.StringTable->GetStringTable()->GetNamespace();
		Out.Key = Place.EntryKey;
		if (!Place.StringTable->GetStringTable()->GetSourceString(FTextKey(Place.EntryKey), Out.Source))
		{
			Why = TEXT("a missing String Table entry");
			return false;
		}
		return true;
	}
	const FText Text = PlaceText(Place);
	FName TableId;
	FString Key;
	if (FTextInspector::GetTableIdAndKey(Text, TableId, Key))
	{
		Out.TableId = TableId.ToString();
		Out.Key = Key;
		const FStringTableConstPtr Table = FStringTableRegistry::Get().FindStringTable(TableId);
		if (!Table || !Table->GetSourceString(FTextKey(Key), Out.Source))
		{
			Why = TEXT("an unresolved String Table reference");
			return false;
		}
		return true;
	}
	if (ReadIdentity(Text, Out, Why)) return true;
	Out = {};
	Out.Source = Text.ToString();
	Out.Unresolved = Text.IsCultureInvariant() ? TEXT("culture_invariant")
		: FTextInspector::GetSourceString(Text) ? TEXT("missing_key") : TEXT("generated");
	return true;
}

bool ReadAfterIdentity(const FAction& Action, const FPlace& Place, FTextIdentity& Out, FString& Why)
{
	if (Place.StringTable && Action.Kind == EEditKind::RemoveStringTableEntry)
	{
		FString Ignored;
		if (Place.StringTable->GetStringTable()->GetSourceString(FTextKey(Place.EntryKey), Ignored)) return false;
		Out = Action.Expected;
		Out.bRemoved = true;
		return true;
	}
	FPlace AfterPlace = Place;
	if (Place.StringTable && Action.Kind == EEditKind::CopyStringTableEntry) AfterPlace.EntryKey = Action.Key;
	return ReadPlaceIdentity(AfterPlace, Out, Why);
}

void RestorePlace(const FPlace& Place, const FOutcome& Outcome)
{
	if (Place.StringTable)
	{
		for (const FStringEntryState& Entry : Outcome.EntriesBefore) SetStringEntry(Place.StringTable, Entry);
		if (Outcome.bRestoreNamespace) Place.StringTable->GetMutableStringTable()->SetNamespace(FTextKey(Outcome.NamespaceBefore));
	}
	else SetPlaceText(Place, Outcome.Original, true);
}

TOptional<FError> ApplyStringTableEdit(const FAction& Action, const FPlace& Place, FOutcome& Outcome)
{
	if (Action.Kind == EEditKind::CopyStringTableEntry || Action.Kind == EEditKind::ChangeStringTableNamespace)
	{
		const FString& Identity = Action.Kind == EEditKind::CopyStringTableEntry ? Action.Key : Action.Namespace;
		const FString Invalid = FString::Printf(TEXT("%s%c%c"), INVALID_NAME_CHARACTERS,
			TextNamespaceUtil::PackageNamespaceStartMarker, TextNamespaceUtil::PackageNamespaceEndMarker);
		if ((!Identity.IsEmpty() && !FName::IsValidXName(Identity, Invalid))
			|| (Action.Kind == EEditKind::CopyStringTableEntry && Identity.TrimStartAndEnd().IsEmpty()))
			return ActionError(TEXT("invalid_request"), Action.Id, TEXT("Unreal does not accept this String Table identity."),
				TEXT("Use a valid String Table key/namespace as required by Unreal's String Table editor."), TEXT("fix_input"));
	}
	FStringEntryState Entry = StringEntryState(Place.StringTable, Place.EntryKey);
	if (!Entry.bExists)
		return ActionError(TEXT("stale_expected"), Action.Id, TEXT("The String Table entry is missing."),
			TEXT("Read the table again before editing."), TEXT("reconcile"));
	if (Action.Kind == EEditKind::CopyStringTableEntry)
	{
		if (Action.Namespace != Place.StringTable->GetStringTable()->GetNamespace())
			return ActionError(TEXT("unsupported_place"), Action.Id, TEXT("All entries in a String Table share its namespace."),
				TEXT("Copy within this namespace, or explicitly review a change_string_table_namespace batch for every entry."), TEXT("fix_input"));
		const FStringEntryState Destination = StringEntryState(Place.StringTable, Action.Key);
		if (Destination.bExists)
			return ActionError(TEXT("key_conflict"), Action.Id, TEXT("The destination String Table entry already exists."),
				TEXT("Choose a free entry key; existing entries are never overwritten by a copy."), TEXT("fix_input"));
		Place.Object->Modify();
		Outcome.EntriesBefore.Add(Destination);
		Entry.Key = Action.Key;
		Entry.Source = Action.Source;
		SetStringEntry(Place.StringTable, Entry);
	}
	else if (Action.Kind == EEditKind::ChangeSource || Action.Kind == EEditKind::RemoveStringTableEntry)
	{
		Place.Object->Modify();
		Outcome.EntriesBefore.Add(Entry);
		Entry.bExists = Action.Kind != EEditKind::RemoveStringTableEntry;
		Entry.Source = Action.Source;
		SetStringEntry(Place.StringTable, Entry);
	}
	else if (Action.Kind == EEditKind::ChangeStringTableNamespace)
	{
		Place.Object->Modify();
		Outcome.bRestoreNamespace = true;
		Outcome.NamespaceBefore = Outcome.Before.Namespace;
		Place.StringTable->GetMutableStringTable()->SetNamespace(FTextKey(Action.Namespace));
	}
	else
		return ActionError(TEXT("unsupported_place"), Action.Id, TEXT("String Table entry identity changes need explicit reference migration."),
			TEXT("Copy the entry, retarget the reviewed references, then explicitly remove or retain the old entry."), TEXT("fix_input"));
	FString Why;
	if (!ReadAfterIdentity(Action, Place, Outcome.After, Why))
		return ActionError(TEXT("not_persisted"), Action.Id, TEXT("The String Table did not retain its edit."),
			TEXT("Inspect the table and mutation receipt."), TEXT("reconcile"));
	Outcome.bChanged = !(Outcome.After == Outcome.Before);
	return {};
}
