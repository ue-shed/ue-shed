#include "UEShedCameraVisibility.h"
#include "Editor.h"
#include "Misc/CoreDelegates.h"
#include "Engine/World.h"
#include "UEShedCameraSubsystem.h"
#include "Modules/ModuleManager.h"
#include "UEShedMapCaptureFreeze.h"
#include "UEShedLitMapTileCapture.h"
#include "UEShedCameraRenderSession.h"
#include "UEShedEditorPreviews.h"
#include "UObject/ObjectSaveContext.h"
#include "UObject/Package.h"

class FUEShedCamerasEditorModule final : public IModuleInterface
{
public:
	virtual void StartupModule() override
    {
        UEShedPreviewVisibilityResolver().BindLambda([](UWorld* World, const TSharedPtr<FJsonObject>& Policy, TArray<TWeakObjectPtr<AActor>>& Hidden, FString& Error) {
            if (!World || World->WorldType != EWorldType::Editor || !GEditor || GEditor->PlayWorld) { Error = TEXT("Authored preview requires the editor world outside Play."); return false; }
            const auto Result = UEShedResolveCameraVisibility(World, Policy);
            Error = Result.Message;
            Hidden = Result.Hidden;
            return Result.Valid;
        });
        UEShedProvisionedEditorPreviewsHook().BindRaw(this, &FUEShedCamerasEditorModule::ApplyFeedPreviews);
        // The live feed outlives any one request, so its reveal follows the editor's lifecycle.
        FeedCleanupHandle = FWorldDelegates::OnWorldCleanup.AddLambda([this](UWorld* Closing, bool, bool) {
            if (FeedWorld.Get() != Closing && FeedWorld.IsValid()) return;
            // A world being torn down discards its proxies; only the serialized flag needs restoring.
            FeedPreviews.Restore(false);
            FeedWorld.Reset();
        });
        // PIE duplicates the editor world; it must see the original flag. The feed's next editor
        // capture after Play ends reveals the previews again.
        FeedPlayHandle = FEditorDelegates::PreBeginPIE.AddLambda([this](bool) { FeedPreviews.Restore(true); });
        // Revealed editor previews must never be saved, including by autosave. The ledger is shared,
        // so this covers every holder.
        FeedPreSaveHandle = FCoreUObjectDelegates::OnObjectPreSave.AddLambda(
            [](UObject* Object, FObjectPreSaveContext) { FUEShedEditorPreviews::PreSave(Object); });
        FeedSavedHandle = UPackage::PackageSavedWithContextEvent.AddLambda(
            [](const FString&, UPackage* Package, FObjectPostSaveContext) { FUEShedEditorPreviews::PostSave(Package); });
        RegisterUEShedMapCaptureFreeze();
        if (GEditor) RegisterThrottleDelegate();
        else PostEngineInitHandle = FCoreDelegates::OnPostEngineInit.AddRaw(
            this, &FUEShedCamerasEditorModule::RegisterThrottleDelegate);
    }
	virtual void ShutdownModule() override
	{
        UEShedPreviewVisibilityResolver().Unbind();
        UEShedProvisionedEditorPreviewsHook().Unbind();
        FWorldDelegates::OnWorldCleanup.Remove(FeedCleanupHandle);
        FEditorDelegates::PreBeginPIE.Remove(FeedPlayHandle);
        FeedPreviews.Restore(true);
        FeedWorld.Reset();
        FCoreUObjectDelegates::OnObjectPreSave.Remove(FeedPreSaveHandle);
        UPackage::PackageSavedWithContextEvent.Remove(FeedSavedHandle);
        FCoreDelegates::OnPostEngineInit.Remove(PostEngineInitHandle);
		if (GEditor)
        {
            GEditor->ShouldDisableCPUThrottlingDelegates.RemoveAll(
                [this](const auto& Delegate) { return Delegate.GetHandle() == ThrottleHandle; });
        }
        ShutdownUEShedLitMapTileCapture();
		FUEShedCameraRenderSession::Shutdown();
		UnregisterUEShedMapCaptureFreeze();
	}
private:
    FDelegateHandle ThrottleHandle;
    FDelegateHandle PostEngineInitHandle;
    FDelegateHandle FeedCleanupHandle, FeedPlayHandle, FeedPreSaveHandle, FeedSavedHandle;
    // One provisioned feed is active at a time; this is its holder in the shared reveal ledger.
    FUEShedEditorPreviews FeedPreviews;
    TWeakObjectPtr<UWorld> FeedWorld;
    int32 ApplyFeedPreviews(UWorld* World, bool bEnabled)
    {
        if (!bEnabled)
        {
            // Another world's feed (for example a PIE world ending) never releases this one.
            if (FeedWorld.IsValid() && FeedWorld.Get() != World) return 0;
            FeedPreviews.Restore(true);
            FeedWorld.Reset();
            return 0;
        }
        // Editor previews exist only in the editor world; a play world shows none.
        if (!World || World->WorldType != EWorldType::Editor || !GEditor || GEditor->PlayWorld) return 0;
        if (FeedWorld.Get() != World)
        {
            FeedPreviews.Restore(true);
            FeedWorld = World;
        }
        return FeedPreviews.Apply(World);
    }
    void RegisterThrottleDelegate()
    {
        if (GEditor)
        {
            auto Delegate = UEditorEngine::FShouldDisableCPUThrottling::CreateRaw(
                this, &FUEShedCamerasEditorModule::ShouldKeepEditorTicking);
            ThrottleHandle = Delegate.GetHandle();
            GEditor->ShouldDisableCPUThrottlingDelegates.Add(Delegate);
        }
    }
    bool ShouldKeepEditorTicking() const
    {
        if (!GEditor) return false;
        UWorld* World = GEditor->GetEditorWorldContext().World();
        const auto* Cameras = World ? World->GetSubsystem<UUEShedCameraSubsystem>() : nullptr;
        return Cameras && Cameras->ShouldKeepEditorTicking();
    }
};

IMPLEMENT_MODULE(FUEShedCamerasEditorModule, UEShedCamerasEditor)
