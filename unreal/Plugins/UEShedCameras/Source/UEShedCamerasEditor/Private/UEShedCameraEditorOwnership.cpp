#include "UEShedCameraEditorOwnership.h"
#include "UEShedCameraRenderSession.h"

namespace { FString AuthoringOwner; }
bool FUEShedCameraEditorOwnership::TryAcquire(const FString& OwnerId)
{
	check(IsInGameThread());
	if (OwnerId.IsEmpty() || !AuthoringOwner.IsEmpty() || FUEShedCameraRenderSession::IsBusy()) return false;
	AuthoringOwner = OwnerId;
	return true;
}
void FUEShedCameraEditorOwnership::Release(const FString& OwnerId)
{
	check(IsInGameThread());
	if (AuthoringOwner == OwnerId) AuthoringOwner.Reset();
}
bool FUEShedCameraEditorOwnership::HasAuthoringOwner() { return !AuthoringOwner.IsEmpty(); }
