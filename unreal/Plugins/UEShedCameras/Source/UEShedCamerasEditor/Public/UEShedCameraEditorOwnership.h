#pragma once
#include "CoreMinimal.h"

/** Game-thread arbitration shared by capture and optional editor tools. No UI dependency. */
class UESHEDCAMERASEDITOR_API FUEShedCameraEditorOwnership
{
public:
	static bool TryAcquire(const FString& OwnerId);
	static void Release(const FString& OwnerId);
	static bool HasAuthoringOwner();
};
