#include "CameraMenuExample.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonSerializer.h"
#include "ToolMenus.h"
#include "UEShedCameraAuthoringBridge.h"

void UCameraMenuExampleLibrary::SubmitAction(const FString& SessionId, const FString& ProducerId,
    int32 ExpectedRevision, const FString& ActionJson, FString& ResultJson)
{
    auto State = FUEShedCameraAuthoringBridge::InspectActive();
    TSharedPtr<FJsonObject> Action;
    if (State->GetStringField(TEXT("status")) != TEXT("ready"))
    {
        FJsonSerializer::Serialize(State.ToSharedRef(), TJsonWriterFactory<>::Create(&ResultJson));
        return;
    }
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ActionJson), Action) || !Action)
    {
        ResultJson = TEXT("{\"version\":1,\"status\":\"invalid\",\"message\":\"Provide a camera panel action.\"}");
        return;
    }
    if (State->GetStringField(TEXT("sessionId")) != SessionId ||
        State->GetStringField(TEXT("producerId")) != ProducerId ||
        State->GetNumberField(TEXT("revision")) != ExpectedRevision)
    {
        ResultJson = TEXT("{\"version\":1,\"status\":\"stale\",\"message\":\"Inspect the matching camera set and retry.\"}");
        return;
    }
    auto Request = MakeShared<FJsonObject>();
    Request->SetNumberField(TEXT("version"), 1);
    Request->SetStringField(TEXT("operation"), TEXT("enqueue"));
    Request->SetStringField(TEXT("sessionId"), State->GetStringField(TEXT("sessionId")));
    Request->SetStringField(TEXT("producerId"), State->GetStringField(TEXT("producerId")));
    Request->SetObjectField(TEXT("action"), Action);
    auto Result = FUEShedCameraAuthoringBridge::Execute(Request);
    FJsonSerializer::Serialize(Result.ToSharedRef(), TJsonWriterFactory<>::Create(&ResultJson));
}

class FCameraMenuExampleModule final : public IModuleInterface
{
    void RegisterMenu()
    {
        FToolMenuOwnerScoped Owner(this);
        UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Window"))->FindOrAddSection(TEXT("WindowLayout"))
            .AddMenuEntry(TEXT("CameraExamplePublish"), FText::FromString(TEXT("Publish attached camera set (example)")),
                FText::FromString(TEXT("Explicitly publish all reviewed cameras through the connected host.")), FSlateIcon(),
                FUIAction(FExecuteAction::CreateLambda([] {
                    auto State = FUEShedCameraAuthoringBridge::InspectActive();
                    if (State->GetStringField(TEXT("status")) != TEXT("ready")) return;
                    const TArray<TSharedPtr<FJsonValue>>* Cameras = nullptr;
                    if (!State->TryGetArrayField(TEXT("cameras"), Cameras)) return;
                    TArray<TSharedPtr<FJsonValue>> Ids;
                    for (const auto& Camera : *Cameras) Ids.Add(MakeShared<FJsonValueString>(Camera->AsObject()->GetStringField(TEXT("id"))));
                    auto Action = MakeShared<FJsonObject>();
                    Action->SetStringField(TEXT("kind"), TEXT("approve"));
                    Action->SetArrayField(TEXT("cameraIds"), Ids);
                    Action->SetArrayField(TEXT("removeRetiredViewIds"), {});
                    FString Json, Result;
                    FJsonSerializer::Serialize(Action, TJsonWriterFactory<>::Create(&Json));
                    UCameraMenuExampleLibrary::SubmitAction(State->GetStringField(TEXT("sessionId")),
                        State->GetStringField(TEXT("producerId")), State->GetNumberField(TEXT("revision")), Json, Result);
                })));
    }
public:
    void StartupModule() override
    {
        UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FCameraMenuExampleModule::RegisterMenu));
    }
    void ShutdownModule() override
    {
        UToolMenus::UnRegisterStartupCallback(this);
        UToolMenus::UnregisterOwner(this);
    }
};
IMPLEMENT_MODULE(FCameraMenuExampleModule, CameraMenuExample)
