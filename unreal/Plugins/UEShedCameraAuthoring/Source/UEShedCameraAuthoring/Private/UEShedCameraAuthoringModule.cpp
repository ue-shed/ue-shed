#include "Framework/Docking/TabManager.h"
#include "Modules/ModuleManager.h"
#include "SCameraArrangementPanel.h"
#include "SCameraSetPreviews.h"
#include "ToolMenus.h"
#include "UEShedCameraAuthoringBridge.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/SWindow.h"

class FUEShedCameraAuthoringMenuModule final : public IModuleInterface
{
    FDelegateHandle FocusHandle;
    static FName TabId()
    {
        return TEXT("UEShedCameraAuthoring");
    }
    static FName PreviewTabId()
    {
        return TEXT("UEShedCameraPreviews");
    }
    TSharedRef<SDockTab> Spawn(const FSpawnTabArgs &Args)
    {
        auto Tab = SNew(SDockTab).TabRole(ETabRole::NomadTab);
        Tab->SetContent(SNew(SCameraArrangementPanel).OnSeePreviews(FSimpleDelegate::CreateLambda([] {
            FGlobalTabmanager::Get()->TryInvokeTab(PreviewTabId());
        })));
        Tab->SetOnTabClosed(SDockTab::FOnTabClosedCallback::CreateLambda([](TSharedRef<SDockTab>) {
            if (auto Review = FGlobalTabmanager::Get()->FindExistingLiveTab(PreviewTabId()))
                Review->RequestCloseTab();
            FUEShedCameraAuthoringBridge::Shutdown();
        }));
        return Tab;
    }
    TSharedRef<SDockTab> SpawnPreviews(const FSpawnTabArgs &Args)
    {
        auto Tab = SNew(SDockTab).TabRole(ETabRole::NomadTab);
        TWeakPtr<SDockTab> WeakTab = Tab;
        auto Review = SNew(SCameraSetPreviews).PreviewVisible_Lambda([WeakTab] {
            const auto Pinned = WeakTab.Pin();
            const auto Window = Pinned ? Pinned->GetParentWindow() : nullptr;
            return Pinned && Pinned->IsForeground() && Window && !Window->IsWindowMinimized();
        });
        Tab->SetContent(Review);
        TWeakPtr<SCameraSetPreviews> WeakReview = Review;
        Tab->SetOnTabClosed(SDockTab::FOnTabClosedCallback::CreateLambda([WeakReview](TSharedRef<SDockTab>) {
            if (auto Pinned = WeakReview.Pin())
                Pinned->Close();
        }));
        return Tab;
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
        FGlobalTabmanager::Get()
            ->RegisterNomadTabSpawner(PreviewTabId(),
                                      FOnSpawnTab::CreateRaw(this, &FUEShedCameraAuthoringMenuModule::SpawnPreviews))
            .SetDisplayName(FText::FromString(TEXT("Camera Previews")))
            .SetMenuType(ETabSpawnerMenuType::Hidden);
        FocusHandle = FUEShedCameraAuthoringBridge::OnEditorFocusRequested().AddLambda(
            [] { FGlobalTabmanager::Get()->TryInvokeTab(TabId()); });
        UToolMenus::RegisterStartupCallback(
            FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FUEShedCameraAuthoringMenuModule::RegisterMenu));
    }
    void ShutdownModule() override
    {
        FUEShedCameraAuthoringBridge::OnEditorFocusRequested().Remove(FocusHandle);
        UToolMenus::UnRegisterStartupCallback(this);
        UToolMenus::UnregisterOwner(this);
        if (auto Tab = FGlobalTabmanager::Get()->FindExistingLiveTab(PreviewTabId()))
            Tab->RequestCloseTab();
        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(PreviewTabId());
        if (auto Tab = FGlobalTabmanager::Get()->FindExistingLiveTab(TabId()))
            Tab->RequestCloseTab();
        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TabId());
    }
};
IMPLEMENT_MODULE(FUEShedCameraAuthoringMenuModule, UEShedCameraAuthoring)
