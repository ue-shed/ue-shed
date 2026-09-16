#include "UEShedEditorWindowLibrary.h"

#include "Dom/JsonObject.h"
#include "Framework/Application/SlateApplication.h"
#include "GenericPlatform/GenericWindow.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IMainFrameModule.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Widgets/SWindow.h"
#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#endif

void UUEShedEditorWindowLibrary::ActivateEditorWindow(const FString& RequestJson, FString& ResultJson)
{
	const uint32 ProcessId = FPlatformProcess::GetCurrentProcessId();
	auto Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("schemaVersion"), 1);
	Result->SetNumberField(TEXT("processId"), ProcessId);
	Result->SetBoolField(TEXT("restored"), false);
	Result->SetStringField(TEXT("target"), TEXT("none"));
	auto Finish = [&](const TCHAR* Status, const TCHAR* Message, const TCHAR* Recovery)
	{
		Result->SetStringField(TEXT("status"), Status);
		Result->SetStringField(TEXT("message"), Message);
		Result->SetStringField(TEXT("recovery"), Recovery);
		FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&ResultJson));
	};

	TSharedPtr<FJsonObject> Request;
	double ExpectedProcessId = 0;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RequestJson), Request)
		|| !Request.IsValid() || !Request->TryGetNumberField(TEXT("expectedProcessId"), ExpectedProcessId)
		|| ExpectedProcessId != ProcessId)
	{
		Finish(TEXT("target_changed"), TEXT("The connected editor identity changed."),
			TEXT("Reconnect to the intended editor and retry."));
		return;
	}
	if (IsRunningCommandlet() || !FSlateApplication::IsInitialized())
	{
		Finish(TEXT("unavailable"), TEXT("This editor has no interactive window."),
			TEXT("Connect to an interactive Unreal Editor."));
		return;
	}
	IMainFrameModule* MainFrame = FModuleManager::GetModulePtr<IMainFrameModule>(TEXT("MainFrame"));
	const TSharedPtr<SWindow> MainWindow = MainFrame ? MainFrame->GetParentWindow() : nullptr;
	if (!MainWindow.IsValid() || !MainWindow->GetNativeWindow().IsValid())
	{
		Finish(TEXT("unavailable"), TEXT("The main editor window is not ready."),
			TEXT("Wait for the editor to finish opening and retry."));
		return;
	}
	const TSharedPtr<SWindow> Modal = FSlateApplication::Get().GetActiveModalWindow();
	const TSharedPtr<SWindow> Target = Modal.IsValid() ? Modal : MainWindow;
	Result->SetStringField(TEXT("target"), Modal.IsValid() ? TEXT("modal") : TEXT("main_editor"));
#if PLATFORM_WINDOWS
	const HWND MainHandle = static_cast<HWND>(MainWindow->GetNativeWindow()->GetOSWindowHandle());
	const TSharedPtr<FGenericWindow> Native = Target->GetNativeWindow();
	const HWND TargetHandle = Native.IsValid() ? static_cast<HWND>(Native->GetOSWindowHandle()) : nullptr;
	DWORD Owner = 0;
	::GetWindowThreadProcessId(TargetHandle, &Owner);
	if (!TargetHandle || Owner != ProcessId)
	{
		Finish(TEXT("unavailable"), TEXT("The editor window is no longer available."),
			TEXT("Retry after the editor finishes changing windows."));
		return;
	}
	const bool Restored = ::IsIconic(MainHandle) != 0;
	if (Restored)
	{
		::ShowWindow(MainHandle, SW_RESTORE);
	}
	Result->SetBoolField(TEXT("restored"), Restored);
	::SetForegroundWindow(TargetHandle);
	if (::GetForegroundWindow() == TargetHandle)
	{
		Finish(TEXT("activated"), TEXT(""), TEXT(""));
	}
	else
	{
		Finish(TEXT("blocked"), TEXT("Windows did not activate the editor window."),
			TEXT("Retry from the active client window, or switch to Unreal from the taskbar."));
	}
#else
	Finish(TEXT("unsupported"), TEXT("Verified window activation is not implemented on this platform."),
		TEXT("Switch to Unreal using your window manager."));
#endif
}
