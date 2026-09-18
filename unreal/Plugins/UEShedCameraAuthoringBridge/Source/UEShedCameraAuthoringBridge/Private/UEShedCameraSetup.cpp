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
void Expire()
{
    const auto W = World();
    if ((!Host.IsEmpty() && FPlatformTime::Seconds() > Deadline) ||
        (Pending && (!W || SetupMap != W->GetOutermost()->GetName())))
    {
        if (Pending) Message = TEXT("Setup interrupted. Check your saved sets before trying again.");
        Pending.Reset();
        Host.Reset();
    }
}
}

TSharedPtr<FJsonObject> FUEShedCameraSetup::Inspect()
{
    Expire();
    auto R = Failure(TEXT("setup"), *Message);
    R->SetBoolField(TEXT("connected"), !Host.IsEmpty());
    if (Pending) R->SetObjectField(TEXT("request"), Pending);
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
            R->SetObjectField(TEXT("selection"), S);
        }
    }
    return R;
}

TSharedPtr<FJsonObject> FUEShedCameraSetup::Execute(const TSharedPtr<FJsonObject>& Q)
{
    Expire();
    if (String(Q, TEXT("operation")) == TEXT("setup_release"))
    {
        if (!Id(String(Q, TEXT("hostId"))) || Host != String(Q, TEXT("hostId")))
            return Failure(TEXT("stale"), TEXT("The setup host no longer owns this connection."));
        if (Pending) Message = TEXT("Setup interrupted. Check your saved sets before trying again.");
        Pending.Reset();
        Host.Reset();
        return Inspect();
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
        Host = RequestedHost;
        Deadline = FPlatformTime::Seconds() + 30;
        if (Outcome && Pending &&
            String(*Outcome, TEXT("id")) == String(Pending, TEXT("id")))
        {
            Message = String(*Outcome, TEXT("error"));
            Pending.Reset();
        }
        return Inspect();
    }
    if (Host.IsEmpty()) return Failure(TEXT("unavailable"), TEXT("Connect a camera host for this project. Workbench can run in the background."));
    if (Pending) return Failure(TEXT("busy"), TEXT("Your camera set is still being created."));
    const TSharedPtr<FJsonObject>* Intent;
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
    SetupMap = W->GetOutermost()->GetName();
    Message.Reset();
    return Inspect();
}
