#include "UEShedCameraSetup.h"
#include "UEShedCameraAuthoringBridge.h"
#include "Editor.h"
#include "Engine/Selection.h"
#include "Engine/World.h"
#include "Misc/App.h"

namespace
{
FString Host, SetupMap, Message;
double Deadline = 0;
TSharedPtr<FJsonObject> Pending;
// Reopening, negotiated per poll by the owning host: whether it can open and what it listed.
bool HostCanOpen = false, PendingOpen = false;
TArray<TSharedPtr<FJsonObject>> Sets;
FString String(const TSharedPtr<FJsonObject>& O, const TCHAR* Key)
{
    FString Value;
    if (O) O->TryGetStringField(Key, Value);
    return Value;
}
bool Id(const FString& Value)
{
    if (Value.IsEmpty() || Value.Len() > 128) return false;
    const auto Alnum = [](TCHAR C) { return (C >= 'a' && C <= 'z') || (C >= 'A' && C <= 'Z') || (C >= '0' && C <= '9'); };
    for (TCHAR C : Value)
        if (!Alnum(C) && C != '-' && C != '_' && C != '.') return false;
    return Alnum(Value[0]);
}
TSharedPtr<FJsonObject> Failure(const TCHAR* Status, const TCHAR* Detail)
{
    auto R = MakeShared<FJsonObject>();
    R->SetNumberField(TEXT("version"), 1);
    R->SetStringField(TEXT("status"), Status);
    R->SetStringField(TEXT("message"), Detail);
    return R;
}
UWorld* World()
{
    return GEditor && !GEditor->PlayWorld ? GEditor->GetEditorWorldContext().World() : nullptr;
}
void Disconnect()
{
    if (Pending) Message = TEXT("Setup interrupted. Check your saved sets before trying again.");
    Pending.Reset();
    PendingOpen = false;
    Host.Reset();
    HostCanOpen = false;
    Sets.Reset();
}
void Expire()
{
    const auto W = World();
    if ((!Host.IsEmpty() && FPlatformTime::Seconds() > Deadline) ||
        (Pending && (!W || SetupMap != W->GetOutermost()->GetName())))
        Disconnect();
}
bool Flag(const TSharedPtr<FJsonObject>& O, const TCHAR* Key)
{
    bool Value = false;
    return O && O->TryGetBoolField(Key, Value) && Value;
}
/** The same bounds as the camera-authoring/v1 setup contract. */
bool ValidSet(const TSharedPtr<FJsonObject>& Set)
{
    const TSharedPtr<FJsonObject>* Subject = nullptr;
    double Cameras = 0;
    if (!Set || !Id(String(Set, TEXT("id"))) || String(Set, TEXT("name")).IsEmpty() || String(Set, TEXT("name")).Len() > 256 ||
        String(Set, TEXT("mapPath")).IsEmpty() || String(Set, TEXT("mapPath")).Len() > 4096 ||
        !Set->TryGetNumberField(TEXT("cameras"), Cameras) || Cameras < 1 || Cameras > 256 ||
        Cameras != FMath::FloorToDouble(Cameras) || !Set->TryGetObjectField(TEXT("subject"), Subject))
        return false;
    const FString Kind = String(*Subject, TEXT("kind"));
    FGuid Guid;
    const FString Path = String(*Subject, TEXT("actorPath"));
    return Kind == TEXT("actor_guid")
               ? FGuid::Parse(String(*Subject, TEXT("actorGuid")), Guid) && Guid.IsValid()
               : Kind == TEXT("actor_path") && Path.StartsWith(TEXT("/Game/")) && Path.Len() <= 4096;
}
/** A GUID subject never falls back to its last known path. */
bool IsSubject(const TSharedPtr<FJsonObject>& Set, const AActor* Actor)
{
    const TSharedPtr<FJsonObject>* Subject = nullptr;
    if (!Set->TryGetObjectField(TEXT("subject"), Subject)) return false;
    FGuid Guid;
    return String(*Subject, TEXT("kind")) == TEXT("actor_guid")
               ? FGuid::Parse(String(*Subject, TEXT("actorGuid")), Guid) && Guid == Actor->GetActorGuid()
               : String(*Subject, TEXT("actorPath")) == Actor->GetPathName();
}
}

TSharedPtr<FJsonObject> FUEShedCameraSetup::Inspect(bool bExtended)
{
    Expire();
    auto R = Failure(TEXT("setup"), *Message);
    R->SetBoolField(TEXT("connected"), !Host.IsEmpty());
    if (Pending && !PendingOpen) R->SetObjectField(TEXT("request"), Pending);
    if (bExtended)
    {
        R->SetBoolField(TEXT("canOpen"), !Host.IsEmpty() && HostCanOpen);
        if (Pending && PendingOpen) R->SetObjectField(TEXT("open"), Pending);
    }
    if (auto W = World())
    {
        AActor* Selected = nullptr;
        int32 Count = 0;
        for (FSelectionIterator It(*GEditor->GetSelectedActors()); It; ++It)
            if (auto A = Cast<AActor>(*It); A && A->GetWorld() == W && !A->IsA<AUEShedAuthoringCamera>())
            {
                Selected = A;
                ++Count;
            }
        if (Count == 1)
        {
            auto S = MakeShared<FJsonObject>();
            S->SetStringField(TEXT("actorPath"), Selected->GetPathName());
            S->SetStringField(TEXT("displayName"), Selected->GetActorLabel());
            S->SetStringField(TEXT("mapPath"), W->GetOutermost()->GetName());
            if (bExtended && Selected->GetActorGuid().IsValid())
                S->SetStringField(TEXT("actorGuid"), Selected->GetActorGuid().ToString(EGuidFormats::UniqueObjectGuid));
            R->SetObjectField(TEXT("selection"), S);
        }
        if (bExtended && HostCanOpen && !Host.IsEmpty())
        {
            // Only the sets whose subject is the one selected actor in this map.
            TArray<TSharedPtr<FJsonValue>> Matching;
            if (Count == 1)
                for (const auto& Set : Sets)
                    if (String(Set, TEXT("mapPath")) == W->GetOutermost()->GetName() && IsSubject(Set, Selected))
                        Matching.Add(MakeShared<FJsonValueObject>(Set));
            R->SetArrayField(TEXT("sets"), Matching);
        }
    }
    return R;
}

TSharedPtr<FJsonObject> FUEShedCameraSetup::Execute(const TSharedPtr<FJsonObject>& Q)
{
    Expire();
    const bool Extended = Flag(Q, TEXT("reopen"));
    if (String(Q, TEXT("operation")) == TEXT("setup_release"))
    {
        if (!Id(String(Q, TEXT("hostId"))) || Host != String(Q, TEXT("hostId")))
            return Failure(TEXT("stale"), TEXT("The setup host no longer owns this connection."));
        Disconnect();
        return Inspect(false);
    }
    if (String(Q, TEXT("operation")) == TEXT("setup_poll"))
    {
        if (String(Q, TEXT("projectName")) != FApp::GetProjectName())
            return Failure(TEXT("stale"), TEXT("The setup host belongs to another project."));
        const FString RequestedHost = String(Q, TEXT("hostId"));
        if (!Id(RequestedHost)) return Failure(TEXT("invalid"), TEXT("A valid setup host identity is required."));
        if (!Host.IsEmpty() && Host != RequestedHost)
            return Failure(TEXT("busy"), TEXT("Another host owns camera setup."));
        const TSharedPtr<FJsonObject>* Outcome = nullptr;
        if (Q->HasField(TEXT("outcome")))
        {
            if (!Q->TryGetObjectField(TEXT("outcome"), Outcome) || !Id(String(*Outcome, TEXT("id"))))
                return Failure(TEXT("invalid"), TEXT("Provide a valid setup outcome."));
            const auto Error = (*Outcome)->Values.Find(TEXT("error"));
            if (!Error || ((*Error)->Type != EJson::String && (*Error)->Type != EJson::Null))
                return Failure(TEXT("invalid"), TEXT("Setup outcome error must be text or null."));
        }
        TArray<TSharedPtr<FJsonObject>> Listed;
        const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
        const bool HasSets = Q->HasField(TEXT("sets"));
        if (HasSets)
        {
            if (!Q->TryGetArrayField(TEXT("sets"), Values) || Values->Num() > 256)
                return Failure(TEXT("invalid"), TEXT("List at most 256 saved camera sets."));
            for (const auto& Value : *Values)
            {
                const TSharedPtr<FJsonObject>* Set = nullptr;
                if (!Value->TryGetObject(Set) || !ValidSet(*Set))
                    return Failure(TEXT("invalid"), TEXT("Each saved set needs an ID, name, map, subject and camera count."));
                Listed.Add(*Set);
            }
        }
        if (Host != RequestedHost)
        {
            HostCanOpen = false;
            Sets.Reset();
        }
        Host = RequestedHost;
        Deadline = FPlatformTime::Seconds() + 30;
        // Each poll states whether this host can reopen; a list replaces the previous one.
        HostCanOpen = Extended;
        if (!Extended) Sets.Reset();
        else if (HasSets) Sets = MoveTemp(Listed);
        if (Outcome && Pending &&
            String(*Outcome, TEXT("id")) == String(Pending, TEXT("id")))
        {
            Message = String(*Outcome, TEXT("error"));
            Pending.Reset();
            PendingOpen = false;
        }
        return Inspect(Extended);
    }
    if (Host.IsEmpty()) return Failure(TEXT("unavailable"), TEXT("Connect a camera host for this project. Workbench can run in the background."));
    if (Pending) return Failure(TEXT("busy"), PendingOpen ? TEXT("Your camera set is still opening.") : TEXT("Your camera set is still being created."));
    const TSharedPtr<FJsonObject>* Intent;
    if (String(Q, TEXT("operation")) == TEXT("setup_open"))
    {
        if (!HostCanOpen)
            return Failure(TEXT("unavailable"), TEXT("This camera host can't reopen saved sets. Open the set from the host app."));
        if (!Q->TryGetObjectField(TEXT("intent"), Intent) || !Id(String(*Intent, TEXT("id"))) ||
            !Id(String(*Intent, TEXT("arrangementId"))))
            return Failure(TEXT("invalid"), TEXT("Choose a saved camera set to open."));
        const FString Wanted = String(*Intent, TEXT("arrangementId"));
        auto W = World();
        if (!W || !Sets.ContainsByPredicate([&Wanted](const auto& Set) { return String(Set, TEXT("id")) == Wanted; }))
            return Failure(TEXT("stale"), TEXT("That saved set is no longer listed. Choose it again."));
        Pending = MakeShared<FJsonObject>();
        Pending->SetStringField(TEXT("id"), String(*Intent, TEXT("id")));
        Pending->SetStringField(TEXT("arrangementId"), Wanted);
        PendingOpen = true;
        SetupMap = W->GetOutermost()->GetName();
        Message.Reset();
        return Inspect(true);
    }
    const TSharedPtr<FJsonObject>* Layout;
    if (!Q->TryGetObjectField(TEXT("intent"), Intent) || !(*Intent)->TryGetObjectField(TEXT("layout"), Layout))
        return Failure(TEXT("invalid"), TEXT("Choose an actor and camera preset."));
    double Count, Start, Span;
    const FString Kind = String(*Layout, TEXT("kind")), Orientation = String(*Layout, TEXT("orientation"));
    if (!Id(String(*Intent, TEXT("id"))) || String(*Intent, TEXT("name")).TrimStartAndEnd().IsEmpty() ||
        String(*Intent, TEXT("name")).Len() > 80 ||
        !(*Layout)->TryGetNumberField(TEXT("count"), Count) || !FMath::IsFinite(Count) || Count < 1 || Count > 256 || Count != FMath::FloorToDouble(Count) ||
        !(*Layout)->TryGetNumberField(TEXT("startDegrees"), Start) || !FMath::IsFinite(Start) ||
        !(*Layout)->TryGetNumberField(TEXT("spanDegrees"), Span) || !FMath::IsFinite(Span) || Span < 0 || Span > 360 ||
        (Kind != TEXT("single") && Kind != TEXT("arc") && Kind != TEXT("orbit")) ||
        (Orientation != TEXT("world") && Orientation != TEXT("subject")))
        return Failure(TEXT("invalid"), TEXT("Provide a name and a valid camera preset."));
    auto W = World();
    const FString Path = String(*Intent, TEXT("actorPath"));
    auto Actor = FindObject<AActor>(nullptr, *Path);
    if (!W || !Actor || Actor->GetWorld() != W || Actor->IsA<AUEShedAuthoringCamera>() ||
        String(*Intent, TEXT("mapPath")) != W->GetOutermost()->GetName() || Path.Len() > 4096)
        return Failure(TEXT("stale"), TEXT("Select a subject actor in the current editor map."));
    Pending = MakeShared<FJsonObject>(**Intent);
    PendingOpen = false;
    SetupMap = W->GetOutermost()->GetName();
    Message.Reset();
    return Inspect(Extended);
}
