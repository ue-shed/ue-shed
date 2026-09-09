#include "Editor.h"
#include "Misc/CoreDelegates.h"
#include "Engine/World.h"
#include "UEShedCameraSubsystem.h"
#include "Modules/ModuleManager.h"
#include "UEShedMapCaptureFreeze.h"
#include "UEShedLitMapTileCapture.h"
#include "UEShedCameraRenderSession.h"

class FUEShedCamerasEditorModule final : public IModuleInterface
{
public:
	virtual void StartupModule() override
    {
        RegisterUEShedMapCaptureFreeze();
        if (GEditor) RegisterThrottleDelegate();
        else PostEngineInitHandle = FCoreDelegates::OnPostEngineInit.AddRaw(
            this, &FUEShedCamerasEditorModule::RegisterThrottleDelegate);
    }
	virtual void ShutdownModule() override
	{
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
