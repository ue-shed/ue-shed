#include "Modules/ModuleManager.h"
#include "UEShedMapCaptureFreeze.h"
#include "UEShedLitMapTileCapture.h"
#include "UEShedCameraRenderSession.h"

class FUEShedCamerasEditorModule final : public IModuleInterface
{
public:
	virtual void StartupModule() override { RegisterUEShedMapCaptureFreeze(); }
	virtual void ShutdownModule() override
	{
		ShutdownUEShedLitMapTileCapture();
		FUEShedCameraRenderSession::Shutdown();
		UnregisterUEShedMapCaptureFreeze();
	}
};

IMPLEMENT_MODULE(FUEShedCamerasEditorModule, UEShedCamerasEditor)
