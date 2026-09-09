#include "UEShedCameraAuthoringBridge.h"
#include "Framework/Docking/TabManager.h"
#include "Modules/ModuleManager.h"
#include "ToolMenus.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

class FUEShedCameraAuthoringMenuModule final : public IModuleInterface
{
	FString LastMessage;
	static FName TabId() { return TEXT("UEShedCameraAuthoring"); }
	FReply Send(const TCHAR* Operation)
	{
		const auto Active = FUEShedCameraAuthoringBridge::InspectActive();
		if (Active->GetStringField(TEXT("status")) != TEXT("ready")) { LastMessage = Active->GetStringField(TEXT("message")); return FReply::Handled(); }
		auto Request = MakeShared<FJsonObject>(); Request->SetNumberField(TEXT("version"), 1);
		Request->SetStringField(TEXT("operation"), Operation);
		Request->SetStringField(TEXT("sessionId"), Active->GetStringField(TEXT("sessionId")));
		Request->SetStringField(TEXT("producerId"), Active->GetStringField(TEXT("producerId")));
		const auto Result = FUEShedCameraAuthoringBridge::Execute(Request);
		LastMessage = Result->GetStringField(TEXT("message")); return FReply::Handled();
	}
	TSharedRef<SWidget> Button(const TCHAR* Label, const TCHAR* Operation)
	{
		return SNew(SButton).Text(FText::FromString(Label)).OnClicked_Lambda([this, Operation]() { return Send(Operation); });
	}
	TSharedRef<SDockTab> Spawn(const FSpawnTabArgs& Args)
	{
		return SNew(SDockTab).TabRole(ETabRole::NomadTab)
		[
			SNew(SBox).Padding(16).MinDesiredWidth(300)
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
				[SNew(STextBlock).AutoWrapText(true).Text_Lambda([this]() {
					const auto Active = FUEShedCameraAuthoringBridge::InspectActive();
					if (Active->GetStringField(TEXT("status")) != TEXT("ready")) return FText::FromString(Active->GetStringField(TEXT("message")));
					return FText::FromString(Active->GetStringField(TEXT("sessionId")) + TEXT(" / ") + Active->GetStringField(TEXT("cameraId")) +
						(Active->GetBoolField(TEXT("saveRequested")) ? TEXT("\nSave pending — waiting for host") : Active->GetBoolField(TEXT("pending")) ? TEXT("\nLocal edits pending") : TEXT("\nSynchronized")) + TEXT("\n") + LastMessage);
				})]
				+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Select camera (edit Transform and FOV in Details)"), TEXT("select"))]
				+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Pilot camera in this viewport"), TEXT("pilot"))]
				+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Stop piloting"), TEXT("eject"))]
				+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Save this view"), TEXT("save"))]
				+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Detach camera"), TEXT("detach"))]
			]
		];
	}
	void RegisterMenu()
	{
		FToolMenuOwnerScoped Owner(this);
		auto* Menu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Window"));
		Menu->FindOrAddSection(TEXT("WindowLayout")).AddMenuEntry(TEXT("UEShedCameraAuthoring"),
			FText::FromString(TEXT("UE Shed Camera Authoring")), FText::FromString(TEXT("Edit an attached camera using native Unreal controls.")),
			FSlateIcon(), FUIAction(FExecuteAction::CreateLambda([]() { FGlobalTabmanager::Get()->TryInvokeTab(TabId()); })));
	}
public:
	void StartupModule() override
	{
		FGlobalTabmanager::Get()->RegisterNomadTabSpawner(TabId(), FOnSpawnTab::CreateRaw(this, &FUEShedCameraAuthoringMenuModule::Spawn)).SetDisplayName(FText::FromString(TEXT("UE Shed Camera Authoring"))).SetMenuType(ETabSpawnerMenuType::Hidden);
		UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FUEShedCameraAuthoringMenuModule::RegisterMenu));
	}
	void ShutdownModule() override
	{
		UToolMenus::UnRegisterStartupCallback(this); UToolMenus::UnregisterOwner(this);
		if (auto Tab = FGlobalTabmanager::Get()->FindExistingLiveTab(TabId())) Tab->RequestCloseTab();
		FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TabId());
	}
};
IMPLEMENT_MODULE(FUEShedCameraAuthoringMenuModule, UEShedCameraAuthoring)
