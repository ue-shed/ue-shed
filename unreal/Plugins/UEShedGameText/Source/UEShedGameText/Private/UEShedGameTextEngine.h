#pragma once

#include "Internationalization/Text.h"
#include "Internationalization/TextPackageNamespaceUtil.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UObject/TextProperty.h"
#include "Runtime/Launch/Resources/Version.h"

#if ENGINE_MAJOR_VERSION < 5
#include "STextPropertyEditableTextBox.h"
#endif

#define UESHED_HAS_TEXT_DEV_NOTES (ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8))

// Keep the action lifecycle shared. These adapters call the selected engine's own identity,
// persistence and redirect implementations; they do not duplicate localization conflict rules.
namespace UEShedGameTextEngine
{
#if ENGINE_MAJOR_VERSION < 5
using FTableKey = FString;
enum class ETextEditAction { Namespace, Key, SourceString };

// The legacy engine exposes stable-ID resolution as a protected static editor API.
struct FLegacyStableText : IEditableTextProperty
{
	using IEditableTextProperty::StaticStableTextId;
};

inline FTextId GetTextId(const FText& Text)
{
	return FTextId(FTextKey(FTextInspector::GetNamespace(Text).Get(FString())),
		FTextKey(FTextInspector::GetKey(Text).Get(FString())));
}

inline FString KeyString(const FTextKey& Key) { return FString(Key.GetChars()); }
inline FString GenerateRandomTextKey() { return FGuid::NewGuid().ToString(); }

inline void GetTextIdForEdit(UPackage* Package, ETextEditAction Action, const FString& Source,
	const FString& Namespace, const FString& Key, FString& OutNamespace, FString& OutKey)
{
	using E = IEditableTextProperty::ETextPropertyEditAction;
	const E LegacyAction = Action == ETextEditAction::Namespace ? E::EditedNamespace
		: Action == ETextEditAction::Key ? E::EditedKey : E::EditedSource;
	FLegacyStableText::StaticStableTextId(Package, LegacyAction, Source, Namespace, Key,
		OutNamespace, OutKey);
}

inline bool EditTextProperty_Direct(UPackage* Package, void* Value, const FTextProperty* Property,
	ETextEditAction Action, const FString& EditValue)
{
	const FText Before = Property->GetPropertyValue(Value);
	const FString* OldSource = FTextInspector::GetSourceString(Before);
	if (Action == ETextEditAction::SourceString && OldSource && *OldSource == EditValue) return true;
	const FString Namespace = Action == ETextEditAction::Namespace ? EditValue
		: FTextInspector::GetNamespace(Before).Get(FString());
	const FString Key = Action == ETextEditAction::Key ? EditValue
		: FTextInspector::GetKey(Before).Get(FString());
	const FString Source = Action == ETextEditAction::SourceString ? EditValue
		: OldSource ? *OldSource : FString();
	FString StableNamespace, StableKey;
	GetTextIdForEdit(Package, Action, Source, Namespace, Key, StableNamespace, StableKey);
	Property->SetPropertyValue(Value,
		FText::ChangeKey(StableNamespace, StableKey, FText::FromString(Source)));
	return true;
}
#else
using FTableKey = FTextKey;
using ETextEditAction = TextNamespaceUtil::ETextEditAction;
using TextNamespaceUtil::EditTextProperty_Direct;
using TextNamespaceUtil::GenerateRandomTextKey;
using TextNamespaceUtil::GetTextIdForEdit;
inline FTextId GetTextId(const FText& Text) { return FTextInspector::GetTextId(Text); }
inline FString KeyString(const FTextKey& Key) { return Key.ToString(); }
#endif

inline FString KeyString(const FString& Key) { return Key; }

inline bool PackageExists(const FString& Name, FString& Filename)
{
#if ENGINE_MAJOR_VERSION < 5
	return FPackageName::DoesPackageExist(Name, nullptr, &Filename);
#else
	return FPackageName::DoesPackageExist(Name, &Filename);
#endif
}

inline bool SavePackage(UPackage* Package, UObject* Asset, const FString& Filename)
{
#if ENGINE_MAJOR_VERSION < 5
	return UPackage::SavePackage(Package, Asset, RF_Public | RF_Standalone, *Filename,
		GError, nullptr, false, true, SAVE_NoError);
#else
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Asset, *Filename, Args);
#endif
}

inline void AddRedirect(const FString& Value)
{
#if ENGINE_MAJOR_VERSION < 5
	TArray<FString> Existing;
	GConfig->GetArray(TEXT("Core.StringTable"), TEXT("StringTableRedirects"), Existing, GEngineIni);
	Existing.AddUnique(Value);
	GConfig->SetArray(TEXT("Core.StringTable"), TEXT("StringTableRedirects"), Existing, GEngineIni);
#else
	GConfig->AddUniqueToSection(TEXT("Core.StringTable"), TEXT("StringTableRedirects"), Value, GEngineIni);
#endif
}
}
