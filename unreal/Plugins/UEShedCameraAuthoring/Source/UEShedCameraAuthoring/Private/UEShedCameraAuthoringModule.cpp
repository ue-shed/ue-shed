#include "Framework/Docking/TabManager.h"
#include "Modules/ModuleManager.h"
#include "SCameraArrangementPanel.h"
#include "SCameraSetPreviews.h"
#include "Styling/AppStyle.h"
#include "UEShedCameraAuthoringBridge.h"
#include "UEShedCameraAuthoringTab.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/SWindow.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"

class FUEShedCameraAuthoringMenuModule final : public IModuleInterface
{
    FDelegateHandle FocusHandle;
    static FName TabId()
    {
        return UEShedCameraAuthoringTab::Id();
    }
    static FName PreviewTabId()
    {
        return UEShedCameraAuthoringTab::PreviewId();
    }
    TSharedRef<SDockTab> Spawn(const FSpawnTabArgs &Args)
    {
        // An explicit label keeps the docked tab short; the Window menu keeps the searchable name.
        auto Tab = SNew(SDockTab)
                       .TabRole(ETabRole::NomadTab)
                       .Label(UEShedCameraAuthoringTab::Label())
                       .ToolTipText(UEShedCameraAuthoringTab::ToolTip());
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

  public:
    void StartupModule() override
    {
        // Listed in Window > Level Editor beside the Outliner and Details panels.
        FGlobalTabmanager::Get()
            ->RegisterNomadTabSpawner(TabId(), FOnSpawnTab::CreateRaw(this, &FUEShedCameraAuthoringMenuModule::Spawn))
            .SetDisplayName(UEShedCameraAuthoringTab::MenuLabel())
            .SetTooltipText(UEShedCameraAuthoringTab::ToolTip())
            .SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), UEShedCameraAuthoringTab::Icon()))
            .SetGroup(WorkspaceMenu::GetMenuStructure().GetLevelEditorCategory());
        FGlobalTabmanager::Get()
            ->RegisterNomadTabSpawner(PreviewTabId(),
                                      FOnSpawnTab::CreateRaw(this, &FUEShedCameraAuthoringMenuModule::SpawnPreviews))
            .SetDisplayName(FText::FromString(TEXT("Camera Previews")))
            .SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), UEShedCameraAuthoringTab::Icon()))
            .SetMenuType(ETabSpawnerMenuType::Hidden);
        FocusHandle = FUEShedCameraAuthoringBridge::OnEditorFocusRequested().AddLambda(
            [] { FGlobalTabmanager::Get()->TryInvokeTab(TabId()); });
    }
    void ShutdownModule() override
    {
        FUEShedCameraAuthoringBridge::OnEditorFocusRequested().Remove(FocusHandle);
        if (auto Tab = FGlobalTabmanager::Get()->FindExistingLiveTab(PreviewTabId()))
            Tab->RequestCloseTab();
        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(PreviewTabId());
        if (auto Tab = FGlobalTabmanager::Get()->FindExistingLiveTab(TabId()))
            Tab->RequestCloseTab();
        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TabId());
    }
};
IMPLEMENT_MODULE(FUEShedCameraAuthoringMenuModule, UEShedCameraAuthoring)
