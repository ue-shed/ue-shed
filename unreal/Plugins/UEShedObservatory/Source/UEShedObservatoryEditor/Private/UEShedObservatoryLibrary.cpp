#include "UEShedObservatoryLibrary.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/Actor.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Subsystems/EditorActorSubsystem.h"
#include "Widgets/SWindow.h"

namespace
{
int64 SnapshotSequence = 0;

TSharedRef<FJsonObject> VectorJson(const FVector& Value)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("x"), Value.X);
	Result->SetNumberField(TEXT("y"), Value.Y);
	Result->SetNumberField(TEXT("z"), Value.Z);
	return Result;
}

TSharedRef<FJsonObject> RotationJson(const FRotator& Value)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("x"), Value.Roll);
	Result->SetNumberField(TEXT("y"), Value.Pitch);
	Result->SetNumberField(TEXT("z"), Value.Yaw);
	return Result;
}

void SerializeJson(const TSharedRef<FJsonObject>& Root, FString& ResultJson)
{
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ResultJson);
	FJsonSerializer::Serialize(Root, Writer);
}

UWorld* ObservedWorld(bool& bIsPie)
{
	bIsPie = false;
	if (GEditor == nullptr) return nullptr;
	if (GEditor->PlayWorld != nullptr)
	{
		bIsPie = true;
		return GEditor->PlayWorld;
	}
	return GEditor->GetEditorWorldContext().World();
}

TSharedRef<FJsonObject> Failure(const FString& Message, const FString& Recovery)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("status"), TEXT("failed"));
	Root->SetStringField(TEXT("message"), Message);
	Root->SetStringField(TEXT("recovery"), Recovery);
	return Root;
}
}

void UUEShedObservatoryLibrary::GetActorSnapshot(FString& ResultJson)
{
	bool bIsPie = false;
	UWorld* World = ObservedWorld(bIsPie);
	if (World == nullptr)
	{
		SerializeJson(Failure(TEXT("No editor world is available."),
			TEXT("Open a map in the Unreal editor and retry.")), ResultJson);
		return;
	}

	TArray<TSharedPtr<FJsonValue>> Actors;
	Actors.Reserve(256);
	constexpr int32 MaxActors = 4096;
	for (TActorIterator<AActor> It(World); It && Actors.Num() < MaxActors; ++It)
	{
		AActor* Actor = *It;
		if (Actor == nullptr || Actor->HasAnyFlags(RF_ClassDefaultObject | RF_Transient)
			|| Actor->IsHiddenEd() || Actor->GetRootComponent() == nullptr)
		{
			continue;
		}
		const FBox Box = Actor->GetComponentsBoundingBox(true, true);
		if (!Box.IsValid) continue;

		const FString Path = Actor->GetPathName();
		const TSharedRef<FJsonObject> Record = MakeShared<FJsonObject>();
		Record->SetStringField(TEXT("id"), Path);
		Record->SetStringField(TEXT("path"), Path);
		Record->SetStringField(TEXT("displayName"), Actor->GetActorLabel());
		Record->SetStringField(TEXT("className"), Actor->GetClass()->GetName());
		Record->SetObjectField(TEXT("location"), VectorJson(Actor->GetActorLocation()));
		Record->SetObjectField(TEXT("rotation"), RotationJson(Actor->GetActorRotation()));
		const TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
		Bounds->SetObjectField(TEXT("center"), VectorJson(Box.GetCenter()));
		Bounds->SetObjectField(TEXT("extent"), VectorJson(Box.GetExtent()));
		Record->SetObjectField(TEXT("bounds"), Bounds);
		Actors.Add(MakeShared<FJsonValueObject>(Record));
	}

	const TSharedRef<FJsonObject> Snapshot = MakeShared<FJsonObject>();
	Snapshot->SetArrayField(TEXT("actors"), Actors);
	Snapshot->SetStringField(TEXT("capturedAt"), FDateTime::UtcNow().ToIso8601());
	Snapshot->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
	Snapshot->SetNumberField(TEXT("sequence"), SnapshotSequence++);
	Snapshot->SetStringField(TEXT("worldKind"), bIsPie ? TEXT("pie") : TEXT("editor"));
	Snapshot->SetNumberField(TEXT("worldSeconds"), World->GetTimeSeconds());

	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("status"), TEXT("ready"));
	Root->SetObjectField(TEXT("snapshot"), Snapshot);
	SerializeJson(Root, ResultJson);
}

void UUEShedObservatoryLibrary::FocusActor(
	const FString& ActorId,
	bool BringToFront,
	FString& ResultJson)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("actorId"), ActorId);
	bool bIsPie = false;
	UWorld* World = ObservedWorld(bIsPie);
	if (World == nullptr)
	{
		Root->SetStringField(TEXT("status"), TEXT("not_supported"));
		SerializeJson(Root, ResultJson);
		return;
	}

	AActor* Match = nullptr;
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		if (It->GetPathName() == ActorId)
		{
			Match = *It;
			break;
		}
	}
	if (Match == nullptr)
	{
		Root->SetStringField(TEXT("status"), TEXT("not_found"));
		SerializeJson(Root, ResultJson);
		return;
	}

	AActor* EditorActor = bIsPie
		? EditorUtilities::GetEditorWorldCounterpartActor(Match)
		: Match;
	if (UEditorActorSubsystem* Actors =
		GEditor->GetEditorSubsystem<UEditorActorSubsystem>())
	{
		Actors->SelectNothing();
		if (EditorActor != nullptr)
		{
			Actors->SetActorSelectionState(EditorActor, true);
		}
	}
	GEditor->MoveViewportCamerasToActor(*Match, false);
	if (BringToFront && FSlateApplication::IsInitialized())
	{
		if (const TSharedPtr<SWindow> Window =
			FSlateApplication::Get().GetActiveTopLevelWindow())
		{
			Window->BringToFront(true);
		}
	}
	Root->SetStringField(TEXT("authoringSubject"),
		EditorActor != nullptr ? TEXT("selected") : TEXT("runtime_only"));
	Root->SetStringField(TEXT("status"), TEXT("focused"));
	SerializeJson(Root, ResultJson);
}
