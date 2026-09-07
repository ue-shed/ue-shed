#include "UEShedCameraReviewLibrary.h"
#include "Editor.h"
#include "Engine/Selection.h"
#include "GameFramework/Actor.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"

void UUEShedCameraReviewLibrary::InspectMapCaptureSelection(FString& ResultJson)
{
 auto Result = MakeShared<FJsonObject>();
 Result->SetNumberField(TEXT("schemaVersion"), 1);
 auto Reject = [&](const TCHAR* Code, const TCHAR* Message) {
  Result->SetStringField(TEXT("status"), TEXT("unavailable"));
  Result->SetStringField(TEXT("code"), Code); Result->SetStringField(TEXT("message"), Message);
  FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&ResultJson));
 };
 if (!GEditor || GEditor->PlayWorld) { Reject(TEXT("editor_required"), TEXT("Stop PIE and select actors in the editor world.")); return; }
 UWorld* World = GEditor->GetEditorWorldContext().World();
 if (!World) { Reject(TEXT("world_unavailable"), TEXT("Open the target map.")); return; }
 TArray<AActor*> Selected;
 GEditor->GetSelectedActors()->GetSelectedObjects<AActor>(Selected);
 if (Selected.IsEmpty() || Selected.Num() > 1024) { Reject(TEXT("selection_limit"), TEXT("Select between 1 and 1024 actors.")); return; }
 FBox Combined(ForceInit);
 TArray<TSharedPtr<FJsonValue>> Actors, Skipped;
 for (AActor* Actor : Selected)
 {
  if (!IsValid(Actor)) continue;
  FBox Bounds = Actor->GetComponentsBoundingBox(true, true);
  if (Actor->GetWorld() != World || !Bounds.IsValid || Bounds.Min.ContainsNaN() || Bounds.Max.ContainsNaN())
  { Skipped.Add(MakeShared<FJsonValueString>(Actor->GetPathName())); continue; }
  Combined += Bounds;
  auto Entry = MakeShared<FJsonObject>();
  Entry->SetStringField(TEXT("path"), Actor->GetPathName());
  Entry->SetStringField(TEXT("label"), Actor->GetActorLabel());
  if (Actor->GetActorGuid().IsValid()) Entry->SetStringField(TEXT("actorGuid"), Actor->GetActorGuid().ToString(EGuidFormats::Digits));
  Actors.Add(MakeShared<FJsonValueObject>(Entry));
 }
 if (!Combined.IsValid || Actors.IsEmpty()) { Reject(TEXT("bounds_unavailable"), TEXT("Select actors with finite component bounds in the current editor world.")); return; }
 auto Bounds = MakeShared<FJsonObject>();
 Bounds->SetNumberField(TEXT("minX"), Combined.Min.X); Bounds->SetNumberField(TEXT("maxX"), Combined.Max.X);
 Bounds->SetNumberField(TEXT("minY"), Combined.Min.Y); Bounds->SetNumberField(TEXT("maxY"), Combined.Max.Y);
 Bounds->SetNumberField(TEXT("minZ"), Combined.Min.Z); Bounds->SetNumberField(TEXT("maxZ"), Combined.Max.Z);
 Result->SetStringField(TEXT("status"), TEXT("ready"));
 Result->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
 Result->SetObjectField(TEXT("bounds"), Bounds); Result->SetArrayField(TEXT("actors"), Actors); Result->SetArrayField(TEXT("skippedActorPaths"), Skipped);
 FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&ResultJson));
}
