#include "UEShedGameTextActions.h"

#include "Containers/StringConv.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraphNode.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/DataTable.h"
#include "Engine/CompositeDataTable.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraph/EdGraphSchema.h"
#include "EdGraphSchema_K2.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/StringTableRegistry.h"
#include "HAL/FileManager.h"
#include "Internationalization/Text.h"
#include "Internationalization/TextNamespaceUtil.h"
#include "Internationalization/TextPackageNamespaceUtil.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UObject/TextProperty.h"
#include "UObject/UnrealType.h"

// ADR 0011. TextNamespaceUtil owns both source edits and requested identity resolution, so
// Unreal's own id rules decide which key a text keeps.
namespace
{
const TCHAR* Contract = TEXT("ue-shed-game-text-actions");
const TCHAR* ContractVersion = TEXT("1.0");
constexpr int32 MaxActions = 256;
constexpr int32 MaxRequestBytes = 1024 * 1024;
constexpr int32 MaxFieldCharacters = 4096;

using ETextEditAction = TextNamespaceUtil::ETextEditAction;

struct FTextIdentity
{
	FString Namespace;
	FString Key;
	FString Source;
	FString TableId;
	FString Unresolved;
	bool bRemoved = false;

	bool operator==(const FTextIdentity& Other) const
	{
		return Namespace.Equals(Other.Namespace, ESearchCase::CaseSensitive)
			&& Key.Equals(Other.Key, ESearchCase::CaseSensitive)
			&& Source.Equals(Other.Source, ESearchCase::CaseSensitive)
			&& TableId == Other.TableId && Unresolved == Other.Unresolved && bRemoved == Other.bRemoved;
	}
};

enum class EEditKind : uint8
{
	ChangeKey,
	RegenerateKey,
	AdoptKey,
	ChangeSource,
	MakeLocalizable,
	CopyStringTableEntry,
	RemoveStringTableEntry,
	ChangeStringTableNamespace,
	RetargetStringTable
};

struct FAction
{
	FString PlaceKind;
	FString Row;
	FString EntryKey;
	FString PinId;
	int32 PinIndex = INDEX_NONE;
	FString TableId;
	FString Id;
	FString ObjectPath;
	FString PackageFile;
	FString PackageName;
	FString ResolvedObjectPath;
	FString PropertyPath;
	FTextIdentity Expected;
	EEditKind Kind = EEditKind::ChangeKey;
	FString Namespace;
	FString Key;
	FString Source;
};

struct FError
{
	FString Code;
	FString ActionId;
	FString Message;
	FString Recovery;
	FString NextStep;
	bool bRetrySafe = false;
};

struct FPlace
{
	UObject* Object = nullptr;
	const FTextProperty* Property = nullptr;
	void* Value = nullptr;
	UEdGraphPin* Pin = nullptr;
	UStringTable* StringTable = nullptr;
	FString EntryKey;
};

struct FStringEntryState
{
	FString Key;
	FString Source;
	FString DevNotes;
	TMap<FName, FString> Metadata;
	bool bExists = false;
};

struct FOutcome
{
	FTextIdentity Before;
	FTextIdentity After;
	FText Original;
	bool bChanged = false;
	bool bMinted = false;
	TArray<FStringEntryState> EntriesBefore;
	FString NamespaceBefore;
	bool bRestoreNamespace = false;
};

FError ActionError(const TCHAR* Code, const FString& ActionId, const FString& Message, const TCHAR* Recovery,
	const TCHAR* NextStep, const bool bRetrySafe = false)
{
	return FError{ Code, ActionId, Message, Recovery, NextStep, bRetrySafe };
}

bool ReadString(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, FString& Out, const bool bAllowEmpty = true)
{
	return Object.IsValid() && Object->TryGetStringField(Field, Out) && Out.Len() <= MaxFieldCharacters
		&& (bAllowEmpty || !Out.IsEmpty());
}

bool ParseEdit(const TSharedPtr<FJsonObject>& Edit, FAction& Action)
{
	FString Kind;
	if (!ReadString(Edit, TEXT("kind"), Kind, false)) return false;
	if (Kind == TEXT("change_key"))
	{
		Action.Kind = EEditKind::ChangeKey;
		return ReadString(Edit, TEXT("namespace"), Action.Namespace) && ReadString(Edit, TEXT("key"), Action.Key, false);
	}
	if (Kind == TEXT("regenerate_key"))
	{
		Action.Kind = EEditKind::RegenerateKey;
		return true;
	}
	if (Kind == TEXT("adopt_key"))
	{
		Action.Kind = EEditKind::AdoptKey;
		return ReadString(Edit, TEXT("namespace"), Action.Namespace) && ReadString(Edit, TEXT("key"), Action.Key, false)
			&& ReadString(Edit, TEXT("source"), Action.Source, false);
	}
	if (Kind == TEXT("change_source"))
	{
		Action.Kind = EEditKind::ChangeSource;
		return ReadString(Edit, TEXT("source"), Action.Source, false);
	}
	if (Kind == TEXT("make_localizable") || Kind == TEXT("copy_string_table_entry"))
	{
		Action.Kind = Kind == TEXT("make_localizable") ? EEditKind::MakeLocalizable : EEditKind::CopyStringTableEntry;
		return ReadString(Edit, TEXT("namespace"), Action.Namespace) && ReadString(Edit, TEXT("key"), Action.Key, false)
			&& ReadString(Edit, TEXT("source"), Action.Source);
	}
	if (Kind == TEXT("remove_string_table_entry")) { Action.Kind = EEditKind::RemoveStringTableEntry; return true; }
	if (Kind == TEXT("change_string_table_namespace"))
	{
		Action.Kind = EEditKind::ChangeStringTableNamespace;
		return ReadString(Edit, TEXT("namespace"), Action.Namespace);
	}
	if (Kind == TEXT("retarget_string_table"))
	{
		Action.Kind = EEditKind::RetargetStringTable;
		return ReadString(Edit, TEXT("tableId"), Action.TableId, false) && ReadString(Edit, TEXT("key"), Action.Key, false)
			&& ReadString(Edit, TEXT("source"), Action.Source);
	}
	return false;
}

/** Reads a localizable text's id with the package namespace removed, or says why it has none. */
bool ReadIdentity(const FText& Text, FTextIdentity& Out, FString& Why)
{
	if (Text.IsCultureInvariant())
	{
		Why = TEXT("culture-invariant text");
		return false;
	}
	if (Text.IsFromStringTable())
	{
		Why = TEXT("a String Table reference");
		return false;
	}
	const FTextId Id = FTextInspector::GetTextId(Text);
	const FString* Source = FTextInspector::GetSourceString(Text);
	if (Id.IsEmpty() || !Source)
	{
		Why = Text.IsEmpty() ? TEXT("empty text") : TEXT("generated text (formatted, numeric or another derived value)");
		return false;
	}
	Out.Namespace = TextNamespaceUtil::StripPackageNamespace(Id.GetNamespace().ToString());
	Out.Key = Id.GetKey().ToString();
	Out.Source = *Source;
	return true;
}

/** `Name`, `Name[3]` or `Name{3}`; the index is -1 when absent. */
bool ParseSegment(const FString& Segment, FString& Name, int32& Index, TCHAR& Bracket)
{
	Index = -1;
	Bracket = 0;
	int32 Open = INDEX_NONE;
	if (!Segment.FindChar(TEXT('['), Open)) Segment.FindChar(TEXT('{'), Open);
	if (Open == INDEX_NONE)
	{
		Name = Segment;
		return !Name.IsEmpty();
	}
	Bracket = Segment[Open];
	const TCHAR Close = Bracket == TEXT('[') ? TEXT(']') : TEXT('}');
	if (Open == 0 || Segment[Segment.Len() - 1] != Close) return false;
	Name = Segment.Left(Open);
	const FString Digits = Segment.Mid(Open + 1, Segment.Len() - Open - 2);
	if (Digits.IsEmpty() || !Digits.IsNumeric() || Digits.Contains(TEXT("-")) || Digits.Contains(TEXT("."))) return false;
	Index = FCString::Atoi(*Digits);
	return true;
}

/**
 * Walks the saved-package reader's property chain: struct members joined by `.`, fixed and dynamic
 * array elements as `[n]`, and map values as `{n}.value` (the nth pair in the map's order).
 */
bool ResolveProperty(UObject* Object, const FString& Path, FPlace& Out, bool& bWrongType,
	const UStruct* RootType = nullptr, void* RootData = nullptr)
{
	bWrongType = false;
	TArray<FString> Segments;
	Path.ParseIntoArray(Segments, TEXT("."), false);
	if (Segments.IsEmpty()) return false;
	const UStruct* Owner = RootType ? RootType : Object->GetClass();
	void* OwnerData = RootData ? RootData : Object;
	const FProperty* Current = nullptr;
	void* CurrentValue = nullptr;
	for (int32 SegmentIndex = 0; SegmentIndex < Segments.Num(); ++SegmentIndex)
	{
		FString Name;
		int32 Index = -1;
		TCHAR Bracket = 0;
		if (!Owner || !ParseSegment(Segments[SegmentIndex], Name, Index, Bracket)) return false;
		const FProperty* Property = FindFProperty<FProperty>(Owner, *Name);
		if (!Property) return false;
		void* Value = Property->ContainerPtrToValuePtr<void>(OwnerData, 0);
		if (Bracket == TEXT('['))
		{
			if (Property->ArrayDim > 1)
			{
				if (Index >= Property->ArrayDim) return false;
				Value = Property->ContainerPtrToValuePtr<void>(OwnerData, Index);
			}
			else if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
			{
				FScriptArrayHelper Helper(Array, Value);
				if (!Helper.IsValidIndex(Index)) return false;
				Value = Helper.GetRawPtr(Index);
				Property = Array->Inner;
			}
			else return false;
		}
		else if (Bracket == TEXT('{'))
		{
			const FMapProperty* Map = CastField<FMapProperty>(Property);
			if (!Map || SegmentIndex + 1 >= Segments.Num() || Segments[SegmentIndex + 1] != TEXT("value")) return false;
			FScriptMapHelper Helper(Map, Value);
			void* Found = nullptr;
			for (int32 Internal = 0, Seen = 0; Internal < Helper.GetMaxIndex(); ++Internal)
			{
				if (!Helper.IsValidIndex(Internal)) continue;
				if (Seen++ == Index)
				{
					Found = Helper.GetValuePtr(Internal);
					break;
				}
			}
			if (!Found) return false;
			Value = Found;
			Property = Map->ValueProp;
			++SegmentIndex;
		}
		Current = Property;
		CurrentValue = Value;
		if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
		{
			Owner = Struct->Struct;
			OwnerData = Value;
		}
		else
		{
			Owner = nullptr;
			OwnerData = nullptr;
		}
	}
	const FTextProperty* Text = CastField<FTextProperty>(Current);
	if (!Text)
	{
		bWrongType = true;
		return false;
	}
	Out.Object = Object;
	Out.Property = Text;
	Out.Value = CurrentValue;
	return true;
}

#include "UEShedGameTextPlaces.inl"

UObject* FindOrLoadObject(const FString& ObjectPath)
{
	if (UObject* Found = StaticFindObject(UObject::StaticClass(), nullptr, *ObjectPath)) return Found;
	// Load the package first, then look again: a nested subobject is found once its package is in memory.
	const FString PackageName = FPackageName::ObjectPathToPackageName(ObjectPath);
	if (!FindPackage(nullptr, *PackageName) && FPackageName::DoesPackageExist(PackageName))
		LoadPackage(nullptr, *PackageName, LOAD_NoWarn | LOAD_Quiet);
	if (UObject* Found = StaticFindObject(UObject::StaticClass(), nullptr, *ObjectPath)) return Found;
	return StaticLoadObject(UObject::StaticClass(), nullptr, *ObjectPath, nullptr, LOAD_NoWarn | LOAD_Quiet);
}

UObject* FindPlaceObject(const FString& ObjectPath)
{
	if (UObject* Found = FindOrLoadObject(ObjectPath)) return Found;
	// The saved-package reader joins every level below the asset with '.', as in
	// `/Game/UI/W_Panel.W_Panel.WidgetTree.Heading`; Unreal names the first one with ':'.
	int32 AssetDot = INDEX_NONE;
	if (ObjectPath.Contains(TEXT(":")) || !ObjectPath.FindChar(TEXT('.'), AssetDot)) return nullptr;
	const int32 SubobjectDot = ObjectPath.Find(TEXT("."), ESearchCase::CaseSensitive, ESearchDir::FromStart, AssetDot + 1);
	if (SubobjectDot == INDEX_NONE) return nullptr;
	FString Subobject = ObjectPath;
	Subobject[SubobjectDot] = TEXT(':');
	return FindOrLoadObject(Subobject);
}

/** The Blueprint whose compile regenerates this object, if any. */
UBlueprint* OwningBlueprint(UObject* Object)
{
	for (UObject* Outer = Object; Outer; Outer = Outer->GetOuter())
	{
		if (UBlueprint* Blueprint = Cast<UBlueprint>(Outer)) return Blueprint;
		if (const UClass* Class = Cast<UClass>(Outer))
		{
			if (UBlueprint* Blueprint = UBlueprint::GetBlueprintFromClass(Class)) return Blueprint;
		}
		if (Outer->HasAnyFlags(RF_ClassDefaultObject))
		{
			if (UBlueprint* Blueprint = UBlueprint::GetBlueprintFromClass(Outer->GetClass())) return Blueprint;
		}
	}
	return nullptr;
}

/** Bind the scanned file to Unreal's actual mount before loading any object. */
TOptional<FError> BindPackage(FAction& Action)
{
	FString Filename = FPaths::IsRelative(Action.PackageFile)
		? FPaths::ConvertRelativePathToFull(FPaths::ProjectDir(), Action.PackageFile)
		: FPaths::ConvertRelativePathToFull(Action.PackageFile);
	FPaths::NormalizeFilename(Filename);
	FPaths::CollapseRelativeDirectories(Filename);
	FString MountedFile;
	if (!FPackageName::TryConvertFilenameToLongPackageName(Filename, Action.PackageName)
		|| !FPackageName::DoesPackageExist(Action.PackageName, &MountedFile)
		|| !FPaths::IsSamePath(Filename, FPaths::ConvertRelativePathToFull(MountedFile)))
	{
		return ActionError(TEXT("package_mismatch"), Action.Id,
			FString::Printf(TEXT("Cannot bind %s to an existing mounted package."), *Action.PackageFile),
			TEXT("Rescan the selected project and verify its content mounts; no object path fallback is allowed."), TEXT("reconcile"));
	}
	FString RelativeObject = Action.ObjectPath;
	if (RelativeObject.StartsWith(TEXT("/")))
	{
		int32 Dot = INDEX_NONE;
		if (!RelativeObject.FindChar(TEXT('.'), Dot))
			return ActionError(TEXT("package_mismatch"), Action.Id, TEXT("An absolute object path needs a package and object."),
				TEXT("Rescan the package and pass its object path with the scanned file."), TEXT("reconcile"));
		RelativeObject = RelativeObject.Mid(Dot + 1);
	}
	Action.ResolvedObjectPath = Action.PackageName + TEXT(".") + RelativeObject;
	return {};
}

/** Resolves one action's place, or the error that stops the request. */
TOptional<FError> Resolve(const FAction& Action, FPlace& Place, const bool bAfter = false, const bool bRestore = false)
{
	UObject* Object = FindPlaceObject(Action.ResolvedObjectPath);
	if (!Object)
	{
		return ActionError(TEXT("place_not_found"), Action.Id, FString::Printf(TEXT("No object at %s."), *Action.ObjectPath),
			TEXT("Rescan the project; the asset may have been renamed, moved or deleted."), TEXT("reconcile"));
	}
	if (Object->GetPackage()->GetName() != Action.PackageName)
	{
		return ActionError(TEXT("package_mismatch"), Action.Id, TEXT("The resolved object belongs to a different package."),
			TEXT("Rescan the selected file; do not edit an object in another package."), TEXT("reconcile"));
	}
	if (Action.PlaceKind == TEXT("string_table_entry"))
	{
		UStringTable* Table = Cast<UStringTable>(Object);
		const FString EntryKey = bAfter && Action.Kind == EEditKind::CopyStringTableEntry ? Action.Key : Action.EntryKey;
		FString Source;
		if (!Table || (!bRestore && !(bAfter && Action.Kind == EEditKind::RemoveStringTableEntry)
			&& !Table->GetStringTable()->GetSourceString(FTextKey(EntryKey), Source)))
			return ActionError(TEXT("place_not_found"), Action.Id, TEXT("The String Table entry does not exist."),
				TEXT("Read the owning table and review its current entry key."), TEXT("reconcile"));
		Place.Object = Object; Place.StringTable = Table; Place.EntryKey = EntryKey;
		return {};
	}
	if (Action.PlaceKind == TEXT("data_table_cell"))
	{
		UDataTable* Table = Cast<UDataTable>(Object);
		if (!Table || Table->IsA<UCompositeDataTable>())
			return ActionError(TEXT("unsupported_place"), Action.Id, TEXT("This cell belongs to an inherited or non-DataTable location."),
				TEXT("Inspect the table's parentTables and explicitly edit the row in its owning parent table."), TEXT("fix_input"));
		uint8* Row = Table->FindRowUnchecked(FName(Action.Row));
		bool bWrongType = false;
		if (!Row || !ResolveProperty(Object, Action.PropertyPath, Place, bWrongType, Table->GetRowStruct(), Row))
			return ActionError(bWrongType ? TEXT("not_text") : TEXT("place_not_found"), Action.Id,
				TEXT("The table row/property chain does not resolve to text."), TEXT("Read the table again; retain the explicit row and nested property chain."), TEXT("reconcile"));
		return {};
	}
	if (Action.PlaceKind == TEXT("graph_pin"))
	{
		UEdGraphNode* Node = Cast<UEdGraphNode>(Object);
		UEdGraphPin* Pin = nullptr;
		FGuid PinId;
		if (Node && !Action.PinId.IsEmpty() && FGuid::Parse(Action.PinId, PinId))
			for (UEdGraphPin* Candidate : Node->Pins) if (Candidate && Candidate->PinId == PinId) { Pin = Candidate; break; }
		if (Node && Action.PinId.IsEmpty() && Node->Pins.IsValidIndex(Action.PinIndex)) Pin = Node->Pins[Action.PinIndex];
		if (!Pin || Pin->PinType.PinCategory != UEdGraphSchema_K2::PC_Text || Pin->Direction != EGPD_Input
			|| Pin->LinkedTo.Num() != 0 || Pin->bDefaultValueIsReadOnly)
			return ActionError(TEXT("unsupported_place"), Action.Id, TEXT("The pin is not an editable, unconnected Text input."),
				TEXT("Read its pin ID/index and edit an authored Text default."), TEXT("fix_input"));
		Place.Object = Node; Place.Pin = Pin;
		return {};
	}
	for (const UObject* Outer = Object; Outer; Outer = Outer->GetOuter())
	{
		if (Outer->IsA<UDataTable>())
		{
			return ActionError(TEXT("unsupported_place"), Action.Id, FString::Printf(TEXT("%s is in a DataTable."), *Action.ObjectPath),
				TEXT("Edit DataTable text through UEShedAuthoring Apply 1.2, which writes text identity."), TEXT("fix_input"));
		}
		if (Outer->IsA<UEdGraphNode>())
		{
			return ActionError(TEXT("unsupported_place"), Action.Id, FString::Printf(TEXT("%s is a graph node."), *Action.ObjectPath),
				TEXT("Graph pin text is not a Game Text action place yet (Plan 058 A2)."), TEXT("fix_input"));
		}
	}
	bool bWrongType = false;
	if (!ResolveProperty(Object, Action.PropertyPath, Place, bWrongType))
	{
		return bWrongType
			? ActionError(TEXT("not_text"), Action.Id,
				FString::Printf(TEXT("%s on %s is not a text property."), *Action.PropertyPath, *Action.ObjectPath),
				TEXT("Name a property chain that ends in a Text property."), TEXT("fix_input"))
			: ActionError(TEXT("place_not_found"), Action.Id,
				FString::Printf(TEXT("No property %s on %s."), *Action.PropertyPath, *Action.ObjectPath),
				TEXT("Rescan the project; the property, element or map entry may no longer exist."), TEXT("reconcile"));
	}
	return {};
}

TOptional<FError> CheckExpected(const FAction& Action, const FPlace& Place, FTextIdentity& Current)
{
	FString Why;
	if (!ReadPlaceIdentity(Place, Current, Why))
	{
		return ActionError(TEXT("read_only_text"), Action.Id,
			FString::Printf(TEXT("%s on %s holds %s, which has no key to edit."), *Action.PropertyPath, *Action.ObjectPath, *Why),
			TEXT("Make the text localizable in Unreal first, or leave it out of the request."), TEXT("fix_input"));
	}
	if ((!Current.TableId.IsEmpty() && Action.Expected.TableId.IsEmpty())
		|| (!Current.Unresolved.IsEmpty() && (Action.Expected.Unresolved.IsEmpty() || Action.Kind != EEditKind::MakeLocalizable)))
		return ActionError(TEXT("read_only_text"), Action.Id, TEXT("This text needs an explicit reference retarget or make_localizable operation."),
			TEXT("Retain the original text kind and source in the expectation; conversion is never implicit."), TEXT("fix_input"));
	if (!(Current == Action.Expected))
	{
		return ActionError(TEXT("stale_expected"), Action.Id,
			FString::Printf(TEXT("%s on %s is now \"%s\" (%s, %s), not the text the request expects."), *Action.PropertyPath,
				*Action.ObjectPath, *Current.Source, *Current.Namespace, *Current.Key),
			TEXT("Rescan the project and review the change again."), TEXT("reconcile"));
	}
	return {};
}

bool Edit(const FPlace& Place, const ETextEditAction EditAction, const FString& Value)
{
	if (Place.Pin)
	{
		const FText Before = PlaceText(Place);
		const FTextId Id = FTextInspector::GetTextId(Before);
		FString Namespace, Key;
		TextNamespaceUtil::GetTextIdForEdit(Place.Object->GetPackage(), EditAction, Value,
			Id.GetNamespace().ToString(), Id.GetKey().ToString(), Namespace, Key);
		return SetPlaceText(Place, FText::ChangeKey(FTextKey(Namespace), FTextKey(Key), FText::FromString(Value)));
	}
	return TextNamespaceUtil::EditTextProperty_Direct(Place.Object->GetPackage(), Place.Value, Place.Property, EditAction, Value);
}

/** Resolve the requested namespace and key together, including a missing package marker. */
bool EditIdentity(const FPlace& Place, const FString& Namespace, const FString& Key)
{
	const FText Text = PlaceText(Place);
	const FString* Source = FTextInspector::GetSourceString(Text);
	if (!Source) return false;
	FString StableNamespace, StableKey;
	TextNamespaceUtil::GetTextIdForEdit(Place.Object->GetPackage(), ETextEditAction::Namespace,
		*Source, Namespace, Key, StableNamespace, StableKey);
	return SetPlaceText(Place, FText::ChangeKey(FTextKey(StableNamespace), FTextKey(StableKey), Text));
}

/** Applies one edit with Unreal's rules, then checks Unreal kept what the action asked for. */
TOptional<FError> ApplyEdit(const FAction& Action, const FPlace& Place, FOutcome& Outcome)
{
	if (Place.StringTable) return ApplyStringTableEdit(Action, Place, Outcome);
	Outcome.Original = PlaceText(Place);
	if ((Action.Kind == EEditKind::CopyStringTableEntry || Action.Kind == EEditKind::RemoveStringTableEntry
		|| Action.Kind == EEditKind::ChangeStringTableNamespace))
		return ActionError(TEXT("unsupported_place"), Action.Id, TEXT("This edit requires an explicit String Table entry."),
			TEXT("Select the owning String Table entry."), TEXT("fix_input"));
	Place.Object->Modify();
	auto Current = [&Place]()
	{
		FTextIdentity Identity;
		FString Why;
		ReadPlaceIdentity(Place, Identity, Why);
		return Identity;
	};
	bool bEdited = true;
	switch (Action.Kind)
	{
	case EEditKind::MakeLocalizable:
		bEdited = !Outcome.Before.Unresolved.IsEmpty() && SetPlaceText(Place, FText::FromString(Action.Source))
			&& EditIdentity(Place, Action.Namespace, Action.Key);
		break;
	case EEditKind::RetargetStringTable:
	{
		const FText Reference = FText::FromStringTable(FName(Action.TableId), Action.Key);
		const FStringTableConstPtr Table = FStringTableRegistry::Get().FindStringTable(FName(Action.TableId));
		FString Source;
		bEdited = Table && Table->GetSourceString(FTextKey(Action.Key), Source) && Source == Action.Source
			&& SetPlaceText(Place, Reference);
		break;
	}
	case EEditKind::RegenerateKey:
		bEdited = EditIdentity(Place, Outcome.Before.Namespace, TextNamespaceUtil::GenerateRandomTextKey());
		Outcome.bMinted = true;
		break;
	case EEditKind::ChangeSource:
		bEdited = Edit(Place, ETextEditAction::SourceString, Action.Source);
		break;
	case EEditKind::AdoptKey:
		bEdited = Edit(Place, ETextEditAction::SourceString, Action.Source);
		[[fallthrough]];
	case EEditKind::ChangeKey:
		bEdited = bEdited && EditIdentity(Place, Action.Namespace, Action.Key);
		break;
	default: bEdited = false; break;
	}
	Outcome.After = Current();
	Outcome.bChanged = !(Outcome.After == Outcome.Before);
	if (Action.Kind == EEditKind::RetargetStringTable && (FName(Outcome.After.TableId) != FName(Action.TableId)
		|| Outcome.After.Key != Action.Key || Outcome.After.Source != Action.Source)) bEdited = false;
	if (!bEdited)
	{
		return ActionError(TEXT("read_only_text"), Action.Id, TEXT("Unreal refused the text edit."),
			TEXT("Check the text in Unreal's details panel."), TEXT("escalate"));
	}
	const bool bWantsKey = Action.Kind == EEditKind::ChangeKey || Action.Kind == EEditKind::AdoptKey || Action.Kind == EEditKind::MakeLocalizable;
	if (bWantsKey && (!Outcome.After.Namespace.Equals(Action.Namespace, ESearchCase::CaseSensitive)
		|| !Outcome.After.Key.Equals(Action.Key, ESearchCase::CaseSensitive)))
	{
		return ActionError(TEXT("key_conflict"), Action.Id,
			FString::Printf(TEXT("Unreal would not keep %s, %s for %s on %s: another text in the package uses that id with different source."),
				*Action.Namespace, *Action.Key, *Action.PropertyPath, *Action.ObjectPath),
			TEXT("Adopt the id with its source (adopt_key), or choose another key."), TEXT("fix_input"));
	}
	return {};
}

TSharedRef<FJsonObject> IdentityJson(const FTextIdentity& Identity, const bool bMinted = false)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("namespace"), Identity.Namespace);
	if (!Identity.TableId.IsEmpty()) Json->SetStringField(TEXT("tableId"), Identity.TableId);
	if (!Identity.Unresolved.IsEmpty()) Json->SetStringField(TEXT("unresolved"), Identity.Unresolved);
	if (Identity.bRemoved) Json->SetBoolField(TEXT("removed"), true);
	if (bMinted) Json->SetBoolField(TEXT("minted"), true);
	else Json->SetStringField(TEXT("key"), Identity.Key);
	Json->SetStringField(TEXT("source"), Identity.Source);
	return Json;
}

FString Serialize(const TSharedRef<FJsonObject>& Json)
{
	FString Result;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Result);
	FJsonSerializer::Serialize(Json, Writer);
	return Result;
}

class FRequestRun
{
public:
	FString Mode = TEXT("dry_run");
	bool bCompile = true;
	bool bSave = false;
	TArray<FAction> Actions;
	TArray<FPlace> Places;
	TArray<FOutcome> Outcomes;
	TArray<FError> Errors;
	TMap<UPackage*, bool> DirtyBefore;
	TArray<UBlueprint*> Blueprints;
	TArray<TPair<FString, bool>> Compiled;
	TArray<TSharedPtr<FJsonValue>> Packages;
	FString Status = TEXT("ok");
	bool bRolledBack = false;
	bool bRollbackFailed = false;
	int32 Applied = 0;

	bool Parse(const FString& RequestJson)
	{
		if (FTCHARToUTF8(*RequestJson).Length() > MaxRequestBytes)
			return Reject(TEXT("The request exceeds 1 MiB."));
		TSharedPtr<FJsonObject> Root;
		if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RequestJson), Root) || !Root.IsValid())
			return Reject(TEXT("The request is not a JSON object."));
		FString RequestContract;
		FString Version;
		if (!ReadString(Root, TEXT("contract"), RequestContract) || RequestContract != Contract
			|| !ReadString(Root, TEXT("version"), Version) || Version != ContractVersion)
			return Reject(TEXT("The request must name contract ue-shed-game-text-actions version 1.0."));
		if (!ReadString(Root, TEXT("mode"), Mode) || (Mode != TEXT("dry_run") && Mode != TEXT("apply")))
			return Reject(TEXT("mode must be dry_run or apply."));
		if (Root->HasField(TEXT("compile")) && !Root->TryGetBoolField(TEXT("compile"), bCompile))
			return Reject(TEXT("compile must be a boolean."));
		if (Root->HasField(TEXT("save")) && !Root->TryGetBoolField(TEXT("save"), bSave))
			return Reject(TEXT("save must be a boolean."));
		if (bSave && !bCompile) return Reject(TEXT("save requires compile, so saved Blueprints match their edits."));
		const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
		if (!Root->TryGetArrayField(TEXT("actions"), Items) || Items->IsEmpty() || Items->Num() > MaxActions)
			return Reject(TEXT("actions must hold 1 to 256 actions."));
		TSet<FString> Ids;
		for (const TSharedPtr<FJsonValue>& Item : *Items)
		{
			const TSharedPtr<FJsonObject>* Object = nullptr;
			if (!Item.IsValid() || !Item->TryGetObject(Object)) return Reject(TEXT("Each action must be an object."));
			FAction Action;
			const TSharedPtr<FJsonObject>* Place = nullptr;
			const TSharedPtr<FJsonObject>* Expected = nullptr;
			const TSharedPtr<FJsonObject>* EditObject = nullptr;
			if (!ReadString(*Object, TEXT("id"), Action.Id, false)
				|| !(*Object)->TryGetObjectField(TEXT("place"), Place)
				|| !ReadString(*Place, TEXT("packageFile"), Action.PackageFile, false)
				|| !ReadString(*Place, TEXT("objectPath"), Action.ObjectPath, false)
				|| !ReadString(*Place, TEXT("propertyPath"), Action.PropertyPath, false)
				|| !(*Object)->TryGetObjectField(TEXT("expected"), Expected)
				|| !ReadString(*Expected, TEXT("namespace"), Action.Expected.Namespace)
				|| !ReadString(*Expected, TEXT("key"), Action.Expected.Key)
				|| !ReadString(*Expected, TEXT("source"), Action.Expected.Source)
				|| !(*Object)->TryGetObjectField(TEXT("edit"), EditObject) || !ParseEdit(*EditObject, Action))
				return Reject(TEXT("An action is missing id, place, expected or a valid edit."), Action.Id);
			if ((*Expected)->HasField(TEXT("unresolved")))
			{
				if (!ReadString(*Expected, TEXT("unresolved"), Action.Expected.Unresolved, false)
					|| !Action.Expected.Namespace.IsEmpty() || !Action.Expected.Key.IsEmpty()
					|| (Action.Expected.Unresolved != TEXT("culture_invariant") && Action.Expected.Unresolved != TEXT("missing_key") && Action.Expected.Unresolved != TEXT("generated")))
					return Reject(TEXT("Invalid explicit unkeyed expectation."), Action.Id);
			}
			else if (Action.Expected.Key.IsEmpty()) return Reject(TEXT("A localized expectation requires a key."), Action.Id);
			if ((*Expected)->HasField(TEXT("tableId")) && !ReadString(*Expected, TEXT("tableId"), Action.Expected.TableId, false))
				return Reject(TEXT("Invalid String Table reference expectation."), Action.Id);
			if ((*Place)->HasField(TEXT("selector")))
			{
				const TSharedPtr<FJsonObject>* Selector = nullptr;
				if (!(*Place)->TryGetObjectField(TEXT("selector"), Selector) || !ReadString(*Selector, TEXT("kind"), Action.PlaceKind, false))
					return Reject(TEXT("Invalid authored location selector."), Action.Id);
				if (Action.PlaceKind == TEXT("data_table_cell"))
				{ if (!ReadString(*Selector, TEXT("row"), Action.Row, false)) return Reject(TEXT("A table cell needs a row."), Action.Id); }
				else if (Action.PlaceKind == TEXT("string_table_entry"))
				{ if (!ReadString(*Selector, TEXT("entryKey"), Action.EntryKey, false)) return Reject(TEXT("A String Table entry needs its key."), Action.Id); }
				else if (Action.PlaceKind == TEXT("graph_pin"))
				{
					const bool bId = (*Selector)->HasField(TEXT("pinId"));
					const bool bIndex = (*Selector)->HasField(TEXT("index"));
					double PinNumber = -1;
					if (bId == bIndex || (bId && !ReadString(*Selector, TEXT("pinId"), Action.PinId, false))
						|| (bIndex && (!(*Selector)->HasTypedField<EJson::Number>(TEXT("index"))
							|| !(*Selector)->TryGetNumberField(TEXT("index"), PinNumber) || PinNumber < 0 || PinNumber > MAX_int32
							|| FMath::FloorToDouble(PinNumber) != PinNumber)))
						return Reject(TEXT("A graph pin needs exactly one pinId or nonnegative index."), Action.Id);
					if (bIndex) Action.PinIndex = static_cast<int32>(PinNumber);
				}
				else return Reject(TEXT("Unknown authored location kind."), Action.Id);
			}
			if (Ids.Contains(Action.Id)) return Reject(TEXT("Action ids must be unique."), Action.Id);
			Ids.Add(Action.Id);
			Actions.Add(MoveTemp(Action));
		}
		return true;
	}

	void Run()
	{
		Places.SetNum(Actions.Num());
		Outcomes.SetNum(Actions.Num());
		TSet<FString> ResolvedPlaces;
		for (int32 Index = 0; Index < Actions.Num(); ++Index)
		{
			if (TOptional<FError> Binding = BindPackage(Actions[Index])) Errors.Add(*Binding);
			else if (TOptional<FError> Error = Resolve(Actions[Index], Places[Index])) Errors.Add(*Error);
			else
			{
				const FPlace& Place = Places[Index];
				const FString Key = Place.StringTable ? FString::Printf(TEXT("%p:%s"), Place.Object,
					*(Actions[Index].Kind == EEditKind::CopyStringTableEntry ? Actions[Index].Key : Place.EntryKey))
					: FString::Printf(TEXT("%p"), Place.Pin ? static_cast<void*>(Place.Pin) : Place.Value);
				if (ResolvedPlaces.Contains(Key)) { Reject(TEXT("Each resolved place may appear in one action only."), Actions[Index].Id); return; }
				ResolvedPlaces.Add(Key);
				if (TOptional<FError> Stale = CheckExpected(Actions[Index], Place, Outcomes[Index].Before)) Errors.Add(*Stale);
			}
		}
		if (!Errors.IsEmpty())
		{
			Status = TEXT("rejected");
			return;
		}
		// A table namespace belongs to every entry. Never authorize a table-wide change by
		// showing the caller just one entry: the proposal must enumerate every affected entry.
		for (int32 Index = 0; Index < Actions.Num(); ++Index)
		{
			if (Actions[Index].Kind != EEditKind::ChangeStringTableNamespace || !Places[Index].StringTable) continue;
			bool bComplete = true;
			Places[Index].StringTable->GetStringTable()->EnumerateSourceStrings([&](const FString& Key, const FString&)
			{
				bool bFound = false;
				for (int32 Other = 0; Other < Actions.Num(); ++Other)
					if (Places[Other].StringTable == Places[Index].StringTable && Places[Other].EntryKey == Key
						&& Actions[Other].Kind == EEditKind::ChangeStringTableNamespace && Actions[Other].Namespace == Actions[Index].Namespace) bFound = true;
				bComplete = bComplete && bFound;
				return true;
			});
			if (!bComplete) { Reject(TEXT("A namespace change must explicitly review every entry in the String Table."), Actions[Index].Id); return; }
		}
		for (const FPlace& Place : Places)
		{
			UPackage* Package = Place.Object->GetPackage();
			if (!DirtyBefore.Contains(Package)) DirtyBefore.Add(Package, Package->IsDirty());
		}
		for (int32 Index = 0; Index < Actions.Num(); ++Index)
		{
			Applied = Index + 1;
			if (TOptional<FError> Error = ApplyEdit(Actions[Index], Places[Index], Outcomes[Index]))
			{
				Errors.Add(*Error);
				Restore();
				Status = TEXT("rejected");
				return;
			}
		}
		if (Mode == TEXT("dry_run"))
		{
			Restore();
			bRolledBack = false;
			return;
		}
		if (bCompile && !CompileAndVerify())
		{
			RestoreAfterCompile();
			Status = TEXT("failed");
			return;
		}
		if (bSave) SavePackages();
	}

	FString Result() const
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("contract"), Contract);
		Root->SetStringField(TEXT("version"), ContractVersion);
		Root->SetStringField(TEXT("mode"), Mode);
		Root->SetStringField(TEXT("status"), Status);
		Root->SetBoolField(TEXT("rolledBack"), bRolledBack);
		TArray<TSharedPtr<FJsonValue>> ActionResults;
		if (Status != TEXT("rejected") || Errors.ContainsByPredicate([](const FError& Error) { return Error.Code == TEXT("key_conflict"); }))
		{
			for (int32 Index = 0; Index < Applied && Index < Outcomes.Num(); ++Index)
			{
				const FOutcome& Outcome = Outcomes[Index];
				const TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
				Item->SetStringField(TEXT("id"), Actions[Index].Id);
				Item->SetStringField(TEXT("status"), bRollbackFailed ? TEXT("unknown")
					: !Outcome.bChanged ? TEXT("unchanged") : Mode == TEXT("dry_run") ? TEXT("planned")
					: bRolledBack ? TEXT("rolled_back") : TEXT("applied"));
				const TSharedRef<FJsonObject> Place = MakeShared<FJsonObject>();
				Place->SetStringField(TEXT("packageFile"), Actions[Index].PackageFile);
				Place->SetStringField(TEXT("objectPath"), Actions[Index].ObjectPath);
				Place->SetStringField(TEXT("propertyPath"), Actions[Index].PropertyPath);
				if (!Actions[Index].PlaceKind.IsEmpty())
				{
					const TSharedRef<FJsonObject> Selector = MakeShared<FJsonObject>();
					Selector->SetStringField(TEXT("kind"), Actions[Index].PlaceKind);
					if (Actions[Index].PlaceKind == TEXT("data_table_cell")) Selector->SetStringField(TEXT("row"), Actions[Index].Row);
					else if (Actions[Index].PlaceKind == TEXT("string_table_entry")) Selector->SetStringField(TEXT("entryKey"), Actions[Index].EntryKey);
					else if (!Actions[Index].PinId.IsEmpty()) Selector->SetStringField(TEXT("pinId"), Actions[Index].PinId);
					else Selector->SetNumberField(TEXT("index"), Actions[Index].PinIndex);
					Place->SetObjectField(TEXT("selector"), Selector);
				}
				Item->SetObjectField(TEXT("place"), Place);
				Item->SetObjectField(TEXT("before"), IdentityJson(Outcome.Before));
				Item->SetObjectField(TEXT("after"), IdentityJson(Outcome.After, Outcome.bMinted && Mode == TEXT("dry_run")));
				ActionResults.Add(MakeShared<FJsonValueObject>(Item));
			}
		}
		Root->SetArrayField(TEXT("actions"), ActionResults);
		TArray<TSharedPtr<FJsonValue>> BlueprintResults;
		for (const TPair<FString, bool>& Entry : Compiled)
		{
			const TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetStringField(TEXT("objectPath"), Entry.Key);
			Item->SetBoolField(TEXT("compiled"), Entry.Value);
			BlueprintResults.Add(MakeShared<FJsonValueObject>(Item));
		}
		Root->SetArrayField(TEXT("blueprints"), BlueprintResults);
		TArray<TSharedPtr<FJsonValue>> PackageResults = Packages;
		if (PackageResults.IsEmpty())
		{
			// A dry run, or an apply without save: the packages an apply would write.
			TSet<FString> Seen;
			for (const FAction& Action : Actions)
			{
				const FString PackageName = Action.PackageName;
				if (Seen.Contains(PackageName)) continue;
				Seen.Add(PackageName);
				const TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
				Item->SetStringField(TEXT("packageName"), PackageName);
				Item->SetStringField(TEXT("packageFile"), Action.PackageFile);
				Item->SetStringField(TEXT("persistence"), TEXT("unsaved"));
				Item->SetBoolField(TEXT("saved"), false);
				PackageResults.Add(MakeShared<FJsonValueObject>(Item));
			}
		}
		Root->SetArrayField(TEXT("packages"), PackageResults);
		TArray<TSharedPtr<FJsonValue>> ErrorResults;
		for (const FError& Error : Errors)
		{
			const TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetStringField(TEXT("code"), Error.Code);
			if (!Error.ActionId.IsEmpty()) Item->SetStringField(TEXT("actionId"), Error.ActionId);
			Item->SetStringField(TEXT("message"), Error.Message);
			Item->SetStringField(TEXT("recovery"), Error.Recovery);
			Item->SetBoolField(TEXT("retrySafe"), Error.bRetrySafe);
			Item->SetStringField(TEXT("nextStep"), Error.NextStep);
			ErrorResults.Add(MakeShared<FJsonValueObject>(Item));
		}
		Root->SetArrayField(TEXT("errors"), ErrorResults);
		return Serialize(Root);
	}

private:
	bool Reject(const TCHAR* Message, const FString& ActionId = FString())
	{
		Errors.Add(ActionError(TEXT("invalid_request"), ActionId, Message,
			TEXT("Send a request that matches the ue-shed-game-text-actions 1.0 contract."), TEXT("fix_input")));
		Status = TEXT("rejected");
		return false;
	}

	/** Puts every edited value back, newest first, and restores each package's dirty flag. */
	void Restore()
	{
		for (int32 Index = Applied - 1; Index >= 0; --Index)
		{
			RestorePlace(Places[Index], Outcomes[Index]);
		}
		for (const TPair<UPackage*, bool>& Entry : DirtyBefore) Entry.Key->SetDirtyFlag(Entry.Value);
		bRolledBack = true;
	}

	bool CompileAndVerify()
	{
		for (const FPlace& Place : Places)
		{
			if (UBlueprint* Blueprint = OwningBlueprint(Place.Object)) Blueprints.AddUnique(Blueprint);
		}
		bool bOk = true;
		for (UBlueprint* Blueprint : Blueprints)
		{
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			FCompilerResultsLog Log;
			Log.bSilentMode = true;
			FKismetEditorUtilities::CompileBlueprint(Blueprint, EBlueprintCompileOptions::SkipGarbageCollection | EBlueprintCompileOptions::SkipSave, &Log);
			const bool bCompiled = Log.NumErrors == 0 && Blueprint->Status != BS_Error;
			Compiled.Add({ Blueprint->GetPathName(), bCompiled });
			if (!bCompiled)
			{
				bOk = false;
				Errors.Add(ActionError(TEXT("compile_failed"), FString(),
					FString::Printf(TEXT("%s failed to compile after the text edits."), *Blueprint->GetPathName()),
					TEXT("Open the Blueprint in Unreal and fix its compile errors, then retry."), TEXT("escalate")));
			}
		}
		if (!bOk) return false;
		// A compile can replace objects (a class default object is rebuilt), so resolve each place again.
		for (int32 Index = 0; Index < Actions.Num(); ++Index)
		{
			FPlace Place;
			FTextIdentity Now;
			FString Why;
			if (Resolve(Actions[Index], Place, true).IsSet()
				|| !ReadAfterIdentity(Actions[Index], Place, Now, Why) || !(Now == Outcomes[Index].After))
			{
				Errors.Add(ActionError(TEXT("not_persisted"), Actions[Index].Id,
					FString::Printf(TEXT("%s on %s did not keep its edit after compiling."), *Actions[Index].PropertyPath,
						*Actions[Index].ObjectPath),
					TEXT("The place is probably a copy a compile regenerates; edit the authored place instead."), TEXT("escalate")));
				return false;
			}
			Places[Index] = Place;
		}
		return true;
	}

	void RestoreAfterCompile()
	{
		for (int32 Index = Applied - 1; Index >= 0; --Index)
		{
			FPlace Place;
			if (!Resolve(Actions[Index], Place, false, true).IsSet()) RestorePlace(Place, Outcomes[Index]);
		}
		bool bRestored = true;
		for (UBlueprint* Blueprint : Blueprints)
		{
			FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
			FCompilerResultsLog Log;
			Log.bSilentMode = true;
			FKismetEditorUtilities::CompileBlueprint(Blueprint, EBlueprintCompileOptions::SkipGarbageCollection | EBlueprintCompileOptions::SkipSave, &Log);
			bRestored = bRestored && Log.NumErrors == 0 && Blueprint->Status != BS_Error;
		}
		for (int32 Index = 0; Index < Applied; ++Index)
		{
			FPlace Place;
			FTextIdentity Current;
			FString Why;
			const bool bMatches = !Resolve(Actions[Index], Place).IsSet()
				&& ReadPlaceIdentity(Place, Current, Why)
				&& Current == Outcomes[Index].Before;
			bRestored = bRestored && bMatches;
		}
		if (bRestored)
			for (const TPair<UPackage*, bool>& Entry : DirtyBefore) Entry.Key->SetDirtyFlag(Entry.Value);
		else
			Errors.Add(ActionError(TEXT("rollback_failed"), FString(), TEXT("Could not verify complete restoration after compilation."),
				TEXT("Inspect every affected live and saved place; do not replay the mutation."), TEXT("reconcile")));
		bRolledBack = bRestored;
		bRollbackFailed = !bRestored;
	}

	void SavePackages()
	{
		for (const TPair<UPackage*, bool>& Entry : DirtyBefore)
		{
			UPackage* Package = Entry.Key;
			const FString Filename = FPackageName::LongPackageNameToFilename(Package->GetName(),
				Package->ContainsMap() ? FPackageName::GetMapPackageExtension() : FPackageName::GetAssetPackageExtension());
			const TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetStringField(TEXT("packageName"), Package->GetName());
			const FAction* Action = Actions.FindByPredicate([Package](const FAction& Candidate) { return Candidate.PackageName == Package->GetName(); });
			Item->SetStringField(TEXT("packageFile"), Action ? Action->PackageFile : Filename);
			FString Persistence = TEXT("unknown");
			bool bSaved = false;
			if (IFileManager::Get().FileExists(*Filename) && IFileManager::Get().IsReadOnly(*Filename))
			{
				Persistence = TEXT("unsaved");
				Errors.Add(ActionError(TEXT("save_failed"), FString(),
					FString::Printf(TEXT("%s is read-only."), *Package->GetName()),
					TEXT("Reconcile live text and saved files, resolve checkout, then explicitly save the reviewed outstanding state; do not replay edits."), TEXT("reconcile")));
			}
			else
			{
				UObject* Asset = Package->FindAssetInPackage();
				FSavePackageArgs Args;
				Args.TopLevelFlags = RF_Public | RF_Standalone;
				Args.SaveFlags = SAVE_NoError;
				bSaved = UPackage::SavePackage(Package, Asset, *Filename, Args);
				if (!bSaved)
				{
					Errors.Add(ActionError(TEXT("save_failed"), FString(),
						FString::Printf(TEXT("Unreal could not save %s."), *Package->GetName()),
						TEXT("Inspect the editor log and saved files, then reconcile before an explicit save; do not replay edits."), TEXT("reconcile")));
				}
			}
			Item->SetBoolField(TEXT("saved"), bSaved);
			Item->SetStringField(TEXT("persistence"), bSaved ? TEXT("saved") : Persistence);
			Packages.Add(MakeShared<FJsonValueObject>(Item));
		}
		if (!Errors.IsEmpty()) Status = TEXT("failed");
	}
};
}

FString UEShedGameText::ApplyTextActions(const FString& RequestJson)
{
	FRequestRun Run;
	if (Run.Parse(RequestJson)) Run.Run();
	return Run.Result();
}

bool UEShedGameText::IsOkResult(const FString& ResultJson)
{
	TSharedPtr<FJsonObject> Root;
	FString Status;
	return FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ResultJson), Root) && Root.IsValid()
		&& Root->TryGetStringField(TEXT("status"), Status) && Status == TEXT("ok");
}
