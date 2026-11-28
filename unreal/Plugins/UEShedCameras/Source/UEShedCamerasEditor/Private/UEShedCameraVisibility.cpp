#include "UEShedCameraVisibility.h"
#include "UEShedCameraEngine.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "LandscapeComponent.h"
#include "SceneView.h"

void FUEShedCameraVisibility::SetupView(FSceneViewFamily &Family, FSceneView &View)
{
    if (!Enabled || !Target || View.State != Target)
        return;
    for (const auto &Component : Components)
        if (Component.IsValid())
            View.HiddenPrimitives.Add(Component->GetPrimitiveSceneId());
}
AActor *UEShedResolveCameraActor(UWorld *World, const TSharedPtr<FJsonObject> &Locator)
{
    FString Kind, Path, GuidText;
    FGuid Guid;
    if (!World || !Locator || !Locator->TryGetStringField(TEXT("kind"), Kind))
        return nullptr;
    const bool ByGuid = Kind == TEXT("actor_guid");
    if (ByGuid ? !Locator->TryGetStringField(TEXT("actorGuid"), GuidText) ||
                     !FGuid::ParseExact(GuidText, EGuidFormats::UniqueObjectGuid, Guid) || !Guid.IsValid()
               : Kind != TEXT("actor_path") || !Locator->TryGetStringField(TEXT("actorPath"), Path) ||
                     !Path.StartsWith(TEXT("/Game/")) || Path.Len() > 4096)
        return nullptr;
    AActor *Match = nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
        if (ByGuid ? It->GetActorGuid() == Guid : It->GetPathName() == Path)
        {
            // A GUID never falls back to a path, and an ambiguous match resolves to nothing.
            if (Match)
                return nullptr;
            Match = *It;
        }
    return Match;
}
TSharedPtr<FJsonObject> UEShedCameraActorEntry(AActor *Actor)
{
    auto Entry = MakeShared<FJsonObject>(), Locator = MakeShared<FJsonObject>();
    const auto Guid = Actor->GetActorGuid();
    if (Guid.IsValid())
    {
        Locator->SetStringField(TEXT("kind"), TEXT("actor_guid"));
        Locator->SetStringField(TEXT("actorGuid"), Guid.ToString(EGuidFormats::UniqueObjectGuid));
        Locator->SetStringField(TEXT("lastKnownActorPath"), Actor->GetPathName());
    }
    else
    {
        Locator->SetStringField(TEXT("kind"), TEXT("actor_path"));
        Locator->SetStringField(TEXT("actorPath"), Actor->GetPathName());
    }
    Entry->SetObjectField(TEXT("locator"), Locator);
    Entry->SetStringField(TEXT("label"), Actor->GetActorLabel().Left(256));
    return Entry;
}
namespace
{
/**
 * Why a component can't be left out, or null when it can. A view hides a component by its scene
 * ID before the renderer looks at what kind of geometry or material it is, so every kind is left
 * out the same way; these two are refused only because no pixel proof covers them yet.
 */
const TCHAR *UnsupportedGeometry(const UPrimitiveComponent *Component)
{
    if (const auto *Mesh = Cast<UStaticMeshComponent>(Component))
        if (Mesh->GetStaticMesh() && UEShedCameraEngine::NaniteSettings(Mesh->GetStaticMesh()).bEnabled)
            return TEXT("Nanite meshes can't be left out of shots yet.");
    if (Component->IsA<ULandscapeComponent>())
        return TEXT("Terrain can't be left out of shots yet.");
    return nullptr;
}
} // namespace
TSharedPtr<FJsonObject> UEShedCameraVisibilityCapabilities()
{
    auto Result = MakeShared<FJsonObject>();
    Result->SetNumberField(TEXT("version"), 1);
    Result->SetNumberField(TEXT("maximumActorsPerList"), 256);
    // The wire name of the first proven scope, kept for strict clients. Preflight answers per actor.
    Result->SetStringField(TEXT("geometry"), TEXT("loaded_non_nanite_opaque_static_mesh_actors"));
    Result->SetBoolField(TEXT("viewport"), true);
    Result->SetBoolField(TEXT("sceneCapture"), true);
    return Result;
}
FUEShedResolvedVisibility UEShedResolveCameraVisibility(UWorld *World, const TSharedPtr<FJsonObject> &Actors)
{
    FUEShedResolvedVisibility Result;
    if (!Actors)
        return Result;
    TSet<AActor *> Hide, Protect;
    TMap<FGuid, TArray<AActor*>> ByActorGuid;
    TMap<FString, TArray<AActor*>> ByActorPath;
    if (World) for (TActorIterator<AActor> It(World); It; ++It) {
        ByActorGuid.FindOrAdd(It->GetActorGuid()).Add(*It);
        ByActorPath.FindOrAdd(It->GetPathName()).Add(*It);
    }
    for (const TCHAR *Field : {TEXT("hide"), TEXT("protect")})
    {
        const TArray<TSharedPtr<FJsonValue>> *Entries = nullptr;
        if (!World || !Actors->TryGetArrayField(Field, Entries) || Entries->Num() > 256)
        {
            Result.Valid = false;
            Result.Message = TEXT("Visibility requires hide/protect arrays of at most 256 actors each.");
            return Result;
        }
        for (const auto &Value : *Entries)
        {
            const TSharedPtr<FJsonObject> *Entry = nullptr;
            const TSharedPtr<FJsonObject> *LocatorPtr = nullptr;
            if (!Value->TryGetObject(Entry) || !(*Entry)->TryGetObjectField(TEXT("locator"), LocatorPtr))
            {
                Result.Valid = false;
                Result.Message = TEXT("An actor entry requires a locator.");
                return Result;
            }
            const auto Locator = *LocatorPtr;
            FString Kind, Path, GuidText;
            FGuid Guid;
            Locator->TryGetStringField(TEXT("kind"), Kind);
            Locator->TryGetStringField(TEXT("actorPath"), Path);
            Locator->TryGetStringField(TEXT("actorGuid"), GuidText);
            const bool ByGuid = Kind == TEXT("actor_guid");
            if ((ByGuid && (!FGuid::ParseExact(GuidText, EGuidFormats::UniqueObjectGuid, Guid) || !Guid.IsValid())) ||
                (!ByGuid && (Kind != TEXT("actor_path") || !Path.StartsWith(TEXT("/Game/")) || Path.Len() > 4096)))
            {
                Result.Valid = false;
                Result.Message = TEXT("Expected a bounded actor path or nonzero actor GUID.");
                return Result;
            }
            const auto* Found = ByGuid ? ByActorGuid.Find(Guid) : ByActorPath.Find(Path);
            const TArray<AActor*> Matches = Found ? *Found : TArray<AActor*>();
            auto Diagnostic = MakeShared<FJsonObject>();
            Diagnostic->SetObjectField(TEXT("locator"), Locator);
            Diagnostic->SetStringField(TEXT("actorPath"), Matches.Num() == 1 ? Matches[0]->GetPathName() : TEXT(""));
            FString Status = Matches.Num() == 1  ? TEXT("resolved")
                             : Matches.IsEmpty() ? TEXT("missing_or_unloaded")
                                                 : TEXT("ambiguous");
            Diagnostic->SetStringField(TEXT("status"), Status);
            Diagnostic->SetStringField(TEXT("message"), Status == TEXT("resolved")
                                                            ? TEXT("")
                                                            : TEXT("Load and resolve this actor before authored "
                                                                   "capture. GUID aliases are not replaced by paths."));
            Result.Diagnostics.Add(MakeShared<FJsonValueObject>(Diagnostic));
            if (Matches.Num() != 1)
            {
                Result.Valid = false;
                Result.Message = TEXT("An authored actor is missing, unloaded, or ambiguous.");
                continue;
            }
            (FCString::Strcmp(Field, TEXT("hide")) == 0 ? Hide : Protect).Add(Matches[0]);
        }
    }
    for (AActor *Actor : Protect)
        Hide.Remove(Actor);
    for (AActor *Actor : Hide)
    {
        // What an actor draws includes the child actors its components spawned.
        TArray<AActor *> Family{Actor};
        Actor->GetAllChildActors(Family, true);
        TArray<UPrimitiveComponent *> Components;
        for (AActor *Member : Family)
            if (Member && !Protect.Contains(Member))
                Components.Append(TInlineComponentArray<UPrimitiveComponent *>(Member));
        const TCHAR *Refusal = Components.IsEmpty() ? TEXT("This actor draws nothing, so there is nothing to leave out.")
                                                    : nullptr;
        for (const UPrimitiveComponent *Component : Components)
            if (!Refusal)
                Refusal = UnsupportedGeometry(Component);
        if (Refusal)
        {
            Result.Valid = false;
            Result.Message = Refusal;
            for (const auto &Value : Result.Diagnostics)
            {
                const auto Diagnostic = Value->AsObject();
                if (Diagnostic->GetStringField(TEXT("actorPath")) == Actor->GetPathName())
                {
                    Diagnostic->SetStringField(TEXT("status"), TEXT("unsupported"));
                    Diagnostic->SetStringField(TEXT("message"), Result.Message);
                }
            }
            continue;
        }
        for (AActor *Member : Family)
            if (Member && !Protect.Contains(Member))
                Result.Hidden.AddUnique(Member);
        for (UPrimitiveComponent *Component : Components)
            Result.Components.AddUnique(Component);
    }
    return Result;
}
