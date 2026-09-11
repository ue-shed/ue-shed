#include "Framework/Docking/TabManager.h"
#include "Modules/ModuleManager.h"
#include "SCameraArrangementPanel.h"
#include "ToolMenus.h"
#include "Widgets/Docking/SDockTab.h"

class FUEShedCameraAuthoringMenuModule final : public IModuleInterface
{
    static FName TabId()
    {
        return TEXT("UEShedCameraAuthoring");
    }
    TSharedRef<SDockTab> Spawn(const FSpawnTabArgs &Args)
    {
        return SNew(SDockTab).TabRole(ETabRole::NomadTab)[SNew(SCameraArrangementPanel)];
    }
    void RegisterMenu()
    {
        FToolMenuOwnerScoped Owner(this);
        auto *Menu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Window"));
        Menu->FindOrAddSection(TEXT("WindowLayout"))
            .AddMenuEntry(
                TabId(), FText::FromString(TEXT("UE Shed Camera Authoring")),
                FText::FromString(TEXT("Author an actor's camera arrangement and per-view exclusions.")), FSlateIcon(),
                FUIAction(FExecuteAction::CreateLambda([] { FGlobalTabmanager::Get()->TryInvokeTab(TabId()); })));
    }

  public:
    void StartupModule() override
    {
        FGlobalTabmanager::Get()
            ->RegisterNomadTabSpawner(TabId(), FOnSpawnTab::CreateRaw(this, &FUEShedCameraAuthoringMenuModule::Spawn))
            .SetDisplayName(FText::FromString(TEXT("UE Shed Camera Authoring")))
            .SetMenuType(ETabSpawnerMenuType::Hidden);
        UToolMenus::RegisterStartupCallback(
            FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FUEShedCameraAuthoringMenuModule::RegisterMenu));
    }
    void ShutdownModule() override
    {
        UToolMenus::UnRegisterStartupCallback(this);
        UToolMenus::UnregisterOwner(this);
        if (auto Tab = FGlobalTabmanager::Get()->FindExistingLiveTab(TabId()))
            Tab->RequestCloseTab();
        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TabId());
    }
};
IMPLEMENT_MODULE(FUEShedCameraAuthoringMenuModule, UEShedCameraAuthoring)
