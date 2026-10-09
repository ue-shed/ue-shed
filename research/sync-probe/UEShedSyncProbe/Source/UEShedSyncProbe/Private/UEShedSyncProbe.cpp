#include "UEShedSyncProbeLibrary.h"
#include "Modules/ModuleManager.h"
#include "Editor.h"
#include "EditorUndoClient.h"
#include "Editor/TransBuffer.h"
#include "Engine/DataTable.h"
#include "Engine/World.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"
#include "UObject/SavePackage.h"
#include "Misc/TransactionObjectEvent.h"
#include "Misc/ITransaction.h"
#include "ScopedTransaction.h"
#include "Misc/PackageName.h"
#include "UObject/StrongObjectPtr.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformTLS.h"
#include "HAL/PlatformMemory.h"
#include "Serialization/JsonSerializer.h"
#include "DataTableEditorUtils.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "PackageTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Editor/EditorPerformanceSettings.h"
#include "Misc/App.h"
#include "HAL/PlatformApplicationMisc.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "Widgets/Text/STextBlock.h"
#include "Layout/Children.h"

namespace Probe
{
FCriticalSection Mutex;
uint64 Counter = 0;
bool Enabled = false;
TMap<FString, int32> Counts;
TMap<FGuid, FTransactionContext> Contexts;
TArray<TPair<TWeakObjectPtr<UDataTable>, FDelegateHandle>> Tables;

FString Encode(const TSharedRef<FJsonObject>& Json)
{
	FString Result;
	FJsonSerializer::Serialize(Json, TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Result));
	return Result;
}
FString File() { return FPaths::ProjectSavedDir() / TEXT("SyncProbe/events.jsonl"); }
TSharedRef<FJsonObject> Event(const FString& Hook, UObject* Object = nullptr)
{
	auto Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("hook"), Hook);
	Json->SetStringField(TEXT("utc"), FDateTime::UtcNow().ToIso8601());
	Json->SetNumberField(TEXT("seconds"), FPlatformTime::Seconds());
	Json->SetNumberField(TEXT("threadId"), FPlatformTLS::GetCurrentThreadId());
	Json->SetBoolField(TEXT("gameThread"), IsInGameThread());
	if (Object)
	{
		Json->SetStringField(TEXT("object"), Object->GetPathName());
		Json->SetStringField(TEXT("class"), Object->GetClass()->GetPathName());
		Json->SetStringField(TEXT("package"), Object->GetOutermost()->GetName());
		Json->SetBoolField(TEXT("dirty"), Object->GetOutermost()->IsDirty());
	}
	return Json;
}
void Write(const TSharedRef<FJsonObject>& Json)
{
	FScopeLock Lock(&Mutex);
	if (!Enabled) return;
	Json->SetNumberField(TEXT("counter"), ++Counter);
	Counts.FindOrAdd(Json->GetStringField(TEXT("hook")))++;
	IFileManager::Get().MakeDirectory(*(FPaths::ProjectSavedDir() / TEXT("SyncProbe")), true);
	FFileHelper::SaveStringToFile(Encode(Json) + TEXT("\n"), *File(), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM, &IFileManager::Get(), FILEWRITE_Append);
}
void ContextFields(const TSharedRef<FJsonObject>& Json, const FTransactionContext& Context)
{
	Json->SetStringField(TEXT("transactionId"), Context.TransactionId.ToString());
	Json->SetStringField(TEXT("operationId"), Context.OperationId.ToString());
	Json->SetStringField(TEXT("title"), Context.Title.ToString());
	Json->SetStringField(TEXT("context"), Context.Context);
}
void WatchTables()
{
	auto& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
	Registry.ScanPathsSynchronous({ TEXT("/Game/Fixture/Authoring") }, true);
	TArray<FAssetData> Assets;
	Registry.GetAssetsByPath(FName(TEXT("/Game/Fixture/Authoring")), Assets, true);
	for (const auto& Asset : Assets)
	{
		if (UDataTable* Table = Cast<UDataTable>(Asset.GetAsset()))
		{
			TWeakObjectPtr<UDataTable> Weak(Table);
			auto Handle = Table->OnDataTableChanged().AddLambda([Weak]() { Write(Event(TEXT("DataTableChanged"), Weak.Get())); });
			Tables.Emplace(Weak, Handle);
		}
	}
}
void ReadCells(const TSharedRef<SWidget>& Widget, const FString& ParentPath, TArray<TSharedPtr<FJsonValue>>& Cells)
{
	FString Path = ParentPath + TEXT("/") + Widget->GetType().ToString();
	if (Widget->GetType() == FName(TEXT("STextBlock")) && Path.Contains(TEXT("SDataTableListViewRow")))
	{
		auto Json = MakeShared<FJsonObject>();
		Json->SetStringField(TEXT("widgetPath"), Path);
		Json->SetStringField(TEXT("text"), StaticCastSharedRef<STextBlock>(Widget)->GetText().ToString());
		Cells.Add(MakeShared<FJsonValueObject>(Json));
	}
	if (FChildren* Children = Widget->GetChildren())
		for (int32 Index = 0; Index < Children->Num(); ++Index) ReadCells(Children->GetChildAt(Index), Path + FString::Printf(TEXT("[%d]"), Index), Cells);
}
}

class FUEShedSyncProbeModule : public IModuleInterface, public FEditorUndoClient
{
	FDelegateHandle Transacted, Property, Modified, Dirty, Marked, State;
public:
	virtual void StartupModule() override
	{
		Transacted = FCoreUObjectDelegates::OnObjectTransacted.AddLambda([](UObject* Object, const FTransactionObjectEvent& E) {
			auto Json = Probe::Event(TEXT("ObjectTransacted"), Object);
			Json->SetNumberField(TEXT("eventType"), int32(E.GetEventType()));
			Json->SetStringField(TEXT("transactionId"), E.GetTransactionId().ToString());
			Json->SetStringField(TEXT("operationId"), E.GetOperationId().ToString());
			Json->SetBoolField(TEXT("nonProperty"), E.HasNonPropertyChanges());
			TArray<TSharedPtr<FJsonValue>> Names;
			for (FName Name : E.GetChangedProperties()) Names.Add(MakeShared<FJsonValueString>(Name.ToString()));
			Json->SetArrayField(TEXT("properties"), Names);
			if (const auto* Context = Probe::Contexts.Find(E.GetTransactionId())) Probe::ContextFields(Json, *Context);
			// The current object-event operation is authoritative; stored context may predate undo.
			Json->SetStringField(TEXT("operationId"), E.GetOperationId().ToString());
			Probe::Write(Json);
		});
		Property = FCoreUObjectDelegates::OnObjectPropertyChanged.AddLambda([](UObject* Object, FPropertyChangedEvent& E) {
			auto Json = Probe::Event(TEXT("PropertyChanged"), Object);
			Json->SetStringField(TEXT("property"), E.GetPropertyName().ToString());
			Json->SetNumberField(TEXT("changeType"), int32(E.ChangeType));
			Probe::Write(Json);
		});
		Modified = FCoreUObjectDelegates::OnObjectModified.AddLambda([](UObject* Object) { Probe::Write(Probe::Event(TEXT("ObjectModified"), Object)); });
		Dirty = UPackage::PackageDirtyStateChangedEvent.AddLambda([](UPackage* Package) { Probe::Write(Probe::Event(TEXT("PackageDirtyStateChanged"), Package)); });
		Marked = UPackage::PackageMarkedDirtyEvent.AddLambda([](UPackage* Package, bool PreviouslyDirty) {
			auto Json = Probe::Event(TEXT("PackageMarkedDirty"), Package);
			Json->SetBoolField(TEXT("previouslyDirty"), PreviouslyDirty);
			Probe::Write(Json);
		});
		if (GEditor)
		{
			GEditor->RegisterForUndo(this);
			if (UTransBuffer* Buffer = Cast<UTransBuffer>(GEditor->Trans))
				State = Buffer->OnTransactionStateChanged().AddLambda([](const FTransactionContext& Context, ETransactionStateEventType Type) {
					Probe::Contexts.Add(Context.TransactionId, Context);
					auto Json = Probe::Event(TEXT("TransactionState"));
					Probe::ContextFields(Json, Context);
					Json->SetNumberField(TEXT("state"), int32(Type));
					Probe::Write(Json);
				});
		}
		Probe::WatchTables();
	}
	virtual bool MatchesContext(const FTransactionContext& Context, const TArray<TPair<UObject*, FTransactionObjectEvent>>& Objects) const override
	{
		auto Json = Probe::Event(TEXT("UndoMatchesContext"));
		Probe::ContextFields(Json, Context);
		Json->SetNumberField(TEXT("objectCount"), Objects.Num());
		Probe::Write(Json);
		return true;
	}
	virtual void PostUndo(bool Success) override { auto Json = Probe::Event(TEXT("PostUndo")); Json->SetBoolField(TEXT("success"), Success); Probe::Write(Json); }
	virtual void PostRedo(bool Success) override { auto Json = Probe::Event(TEXT("PostRedo")); Json->SetBoolField(TEXT("success"), Success); Probe::Write(Json); }
	virtual void ShutdownModule() override
	{
		Probe::Enabled = false;
		FCoreUObjectDelegates::OnObjectTransacted.Remove(Transacted);
		FCoreUObjectDelegates::OnObjectPropertyChanged.Remove(Property);
		FCoreUObjectDelegates::OnObjectModified.Remove(Modified);
		UPackage::PackageDirtyStateChangedEvent.Remove(Dirty);
		UPackage::PackageMarkedDirtyEvent.Remove(Marked);
		for (const auto& Entry : Probe::Tables) if (Entry.Key.IsValid()) Entry.Key->OnDataTableChanged().Remove(Entry.Value);
		if (GEditor) { GEditor->UnregisterForUndo(this); if (auto* Buffer = Cast<UTransBuffer>(GEditor->Trans)) Buffer->OnTransactionStateChanged().Remove(State); }
	}
};
IMPLEMENT_MODULE(FUEShedSyncProbeModule, UEShedSyncProbe)

void UUEShedSyncProbeLibrary::Mark(const FString& Label, FString& ResultJson)
{
	Probe::Enabled = true;
	auto Json = Probe::Event(TEXT("Mark"));
	Json->SetStringField(TEXT("label"), Label);
	Probe::Write(Json);
	ResultJson = Probe::Encode(Json);
}
void UUEShedSyncProbeLibrary::Clear(FString& ResultJson)
{
	FScopeLock Lock(&Probe::Mutex);
	Probe::Enabled = false; Probe::Counter = 0; Probe::Counts.Empty();
	IFileManager::Get().Delete(*Probe::File());
	ResultJson = TEXT("{\"cleared\":true}");
}
void UUEShedSyncProbeLibrary::GetCounts(FString& ResultJson)
{
	auto Json = Probe::Event(TEXT("Counts"));
	auto Counts = MakeShared<FJsonObject>();
	for (const auto& Entry : Probe::Counts) Counts->SetNumberField(Entry.Key, Entry.Value);
	Json->SetObjectField(TEXT("counts"), Counts);
	Json->SetNumberField(TEXT("tablesWatched"), Probe::Tables.Num());
	Json->SetNumberField(TEXT("processPhysicalBytes"), FPlatformMemory::GetStats().UsedPhysical);
	Json->SetBoolField(TEXT("throttleCPUWhenNotForeground"), GetDefault<UEditorPerformanceSettings>()->bThrottleCPUWhenNotForeground);
	Json->SetBoolField(TEXT("appHasFocus"), FApp::HasFocus());
	Json->SetBoolField(TEXT("nativeForeground"), FPlatformApplicationMisc::IsThisApplicationForeground());
	Json->SetBoolField(TEXT("effectiveShouldThrottle"), GEditor->ShouldThrottleCPUUsage());
	Json->SetBoolField(TEXT("unattended"), FApp::IsUnattended());
	if (auto* Buffer = Cast<UTransBuffer>(GEditor->Trans))
	{
		Json->SetNumberField(TEXT("queueLength"), Buffer->GetQueueLength());
		Json->SetNumberField(TEXT("undoCount"), Buffer->GetUndoCount());
		Json->SetNumberField(TEXT("undoBytes"), Buffer->GetUndoSize());
	}
	ResultJson = Probe::Encode(Json);
}
void UUEShedSyncProbeLibrary::Undo(FString& ResultJson) { auto Json = Probe::Event(TEXT("UndoResult")); Json->SetBoolField(TEXT("success"), GEditor->UndoTransaction()); ResultJson = Probe::Encode(Json); }
void UUEShedSyncProbeLibrary::Redo(FString& ResultJson) { auto Json = Probe::Event(TEXT("RedoResult")); Json->SetBoolField(TEXT("success"), GEditor->RedoTransaction()); ResultJson = Probe::Encode(Json); }

void UUEShedSyncProbeLibrary::Scenario(const FString& RequestJson, FString& ResultJson)
{
	TSharedPtr<FJsonObject> Request;
	auto Result = Probe::Event(TEXT("ScenarioResult"));
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RequestJson), Request) || !Request.IsValid()) { ResultJson = TEXT("{\"error\":\"invalid JSON\"}"); return; }
	const FString Action = Request->GetStringField(TEXT("action"));
	Result->SetStringField(TEXT("action"), Action);
	if (Action == TEXT("noop")) { ResultJson = Probe::Encode(Result); return; }
	if (Action == TEXT("throttle")) { GetMutableDefault<UEditorPerformanceSettings>()->bThrottleCPUWhenNotForeground = Request->GetBoolField(TEXT("value")); ResultJson = Probe::Encode(Result); return; }
	if (Action == TEXT("ui-text"))
	{
		TArray<TSharedPtr<FJsonValue>> Cells;
		for (const auto& Window : FSlateApplication::Get().GetTopLevelWindows()) Probe::ReadCells(Window, Window->GetTitle().ToString(), Cells);
		Result->SetArrayField(TEXT("cells"), Cells);
		ResultJson = Probe::Encode(Result); return;
	}
	if (Action == TEXT("actor"))
	{
		UWorld* World = GEditor->GetEditorWorldContext().World();
		AUEShedSyncProbeActor* Actor = World->SpawnActor<AUEShedSyncProbeActor>();
		FProperty* Property = FindFProperty<FProperty>(Actor->GetClass(), TEXT("Value"));
		FScopedTransaction Transaction(TEXT("UEShedSyncProbe"), FText::FromString(Action), Actor);
		Actor->Modify(); Actor->PreEditChange(Property);
		Probe::Write(Probe::Event(TEXT("MutationStart"), Actor));
		Actor->Value += 1;
		FPropertyChangedEvent E(Property, EPropertyChangeType::ValueSet); Actor->PostEditChangeProperty(E);
		Result->SetStringField(TEXT("object"), Actor->GetPathName());
		ResultJson = Probe::Encode(Result); return;
	}
	if (Action == TEXT("property") || Action == TEXT("interactive"))
	{
		static TStrongObjectPtr<UUEShedSyncProbeDataAsset> Asset;
		if (!Asset.IsValid()) Asset.Reset(NewObject<UUEShedSyncProbeDataAsset>(CreatePackage(TEXT("/Game/Fixture/Authoring/ProbeDataAsset")), TEXT("ProbeDataAsset"), RF_Public | RF_Standalone | RF_Transactional));
		FProperty* Property = FindFProperty<FProperty>(Asset->GetClass(), TEXT("Value"));
		FScopedTransaction Transaction(TEXT("UEShedSyncProbe"), FText::FromString(Action), Asset.Get());
		Asset->Modify(); Asset->PreEditChange(Property);
		Probe::Write(Probe::Event(TEXT("MutationStart"), Asset.Get()));
		if (Action == TEXT("interactive"))
		{
			for (int32 Index = 0; Index < 3; ++Index) { Asset->Value += 1; FPropertyChangedEvent E(Property, EPropertyChangeType::Interactive); Asset->PostEditChangeProperty(E); SnapshotTransactionBuffer(Asset.Get()); }
		}
		Asset->Value += 1;
		FPropertyChangedEvent E(Property, EPropertyChangeType::ValueSet); Asset->PostEditChangeProperty(E);
		Result->SetStringField(TEXT("object"), Asset->GetPathName());
		Result->SetNumberField(TEXT("value"), Asset->Value);
		ResultJson = Probe::Encode(Result); return;
	}
	FString Path; Request->TryGetStringField(TEXT("table"), Path);
	if (!Path.StartsWith(TEXT("/Game/Fixture/Authoring/"))) { ResultJson = TEXT("{\"error\":\"fixture authoring paths only\"}"); return; }
	UDataTable* Table = LoadObject<UDataTable>(nullptr, *Path);
	if (!Table) { ResultJson = TEXT("{\"error\":\"table not found\"}"); return; }
	FString RowString; Request->TryGetStringField(TEXT("row"), RowString);
	FName Row(*RowString);
	bool Success = true;
	if (Action == TEXT("row-add")) Success = FDataTableEditorUtils::AddRow(Table, Row) != nullptr;
	else if (Action == TEXT("row-remove")) Success = FDataTableEditorUtils::RemoveRow(Table, Row);
	else if (Action == TEXT("row-rename")) Success = FDataTableEditorUtils::RenameRow(Table, Row, FName(*Request->GetStringField(TEXT("newRow"))));
	else if (Action == TEXT("row-reorder")) Success = FDataTableEditorUtils::MoveRow(Table, Row, FDataTableEditorUtils::ERowMoveDirection::Down);
	else if (Action == TEXT("open")) { auto* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>(); Success = Editors->OpenEditorForAsset(Table); Result->SetBoolField(TEXT("editorFound"), Editors->FindEditorForAsset(Table, false) != nullptr); }
	else if (Action == TEXT("save"))
	{
		FString Filename = FPackageName::LongPackageNameToFilename(Table->GetOutermost()->GetName(), FPackageName::GetAssetPackageExtension());
		FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone; Args.SaveFlags = SAVE_NoError;
		Success = UPackage::SavePackage(Table->GetOutermost(), Table, *Filename, Args);
		Result->SetStringField(TEXT("saved"), Filename);
	}
	else if (Action == TEXT("reload") || Action == TEXT("revert")) { FText Error; Success = UPackageTools::ReloadPackages({Table->GetOutermost()}, Error, Action == TEXT("revert") ? EReloadPackagesInteractionMode::AssumePositive : EReloadPackagesInteractionMode::AssumeNegative); Result->SetStringField(TEXT("error"), Error.ToString()); Table = LoadObject<UDataTable>(nullptr, *Path); }
	else if (Action == TEXT("cell") || Action == TEXT("raw-cell") || Action == TEXT("cancel"))
	{
		uint8* Bytes = Table->FindRowUnchecked(Row);
		FNumericProperty* Property = FindFProperty<FNumericProperty>(Table->GetRowStruct(), FName(*Request->GetStringField(TEXT("field"))));
		if (!Bytes || !Property || !Property->IsInteger()) { ResultJson = TEXT("{\"error\":\"integer field/row missing\"}"); return; }
		if (Action == TEXT("raw-cell")) Property->SetIntPropertyValue(Property->ContainerPtrToValuePtr<void>(Bytes), int64(Request->GetNumberField(TEXT("value"))));
		else
		{
			FScopedTransaction Transaction(TEXT("UEShedSyncProbe"), FText::FromString(Action), Table);
			FDataTableEditorUtils::BroadcastPreChange(Table, FDataTableEditorUtils::EDataTableChangeInfo::RowData);
			Table->Modify();
			Probe::Write(Probe::Event(TEXT("MutationStart"), Table));
			Property->SetIntPropertyValue(Property->ContainerPtrToValuePtr<void>(Bytes), int64(Request->GetNumberField(TEXT("value"))));
			FDataTableEditorUtils::BroadcastPostChange(Table, FDataTableEditorUtils::EDataTableChangeInfo::RowData);
			if (Action == TEXT("cancel")) Transaction.Cancel();
		}
	}
	else { Success = false; Result->SetStringField(TEXT("error"), TEXT("unknown action")); }
	Result->SetBoolField(TEXT("success"), Success);
	Result->SetBoolField(TEXT("dirty"), Table->GetOutermost()->IsDirty());
	ResultJson = Probe::Encode(Result);
}
