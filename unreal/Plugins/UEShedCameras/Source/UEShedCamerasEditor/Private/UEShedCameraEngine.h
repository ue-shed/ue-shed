#pragma once

#include "Engine/StaticMesh.h"
#include "HAL/IConsoleManager.h"
#include "Runtime/Launch/Resources/Version.h"

namespace UEShedCameraEngine
{
inline FMeshNaniteSettings& NaniteSettings(UStaticMesh* Mesh)
{
#if ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 7)
	return Mesh->GetNaniteSettings();
#else
	return Mesh->NaniteSettings;
#endif
}

inline bool IsArrayPriority(EConsoleVariableFlags Priority)
{
	return Priority == ECVF_SetByScalability || Priority == ECVF_SetByPluginLowPriority ||
		Priority == ECVF_SetByDeviceProfile || Priority == ECVF_SetByPluginHighPriority ||
		Priority == ECVF_SetByHotfix || Priority == ECVF_SetByPreview;
}

inline void SetScreenshotWarmupValue(IConsoleVariable* Variable, int32 Value)
{
#if ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 7)
	// ReplaceCurrent refuses constructor values. Preserve configured values' priority/tag.
	if ((Variable->GetFlags() & ECVF_SetByMask) == ECVF_SetByConstructor)
		Variable->Set(Value, ECVF_SetByConstructor);
	else
		Variable->ReplaceCurrentPriorityAndTag(Value);
#else
	const auto Priority = static_cast<EConsoleVariableFlags>(Variable->GetFlags() & ECVF_SetByMask);
	// UE5.6 cannot replace the current tag. Own a temporary entry at array priorities so
	// restoration can remove it without changing the original tagged history.
	Variable->Set(Value, Priority, IsArrayPriority(Priority) ? FName(TEXT("UEShedScreenshotWarmup")) : NAME_None);
#endif
}

inline void ReleaseScreenshotWarmupValue(IConsoleVariable* Variable, uint32 OriginalFlags)
{
#if ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 7)
	// Newer engines replace the existing entry and do not own an additional tag.
#else
	const auto Priority = static_cast<EConsoleVariableFlags>(OriginalFlags & ECVF_SetByMask);
	if (IsArrayPriority(Priority))
		Variable->Unset(Priority, FName(TEXT("UEShedScreenshotWarmup")));
#endif
}

inline void RestoreScreenshotWarmupValue(IConsoleVariable* Variable, int32 Value)
{
#if ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 7)
	SetScreenshotWarmupValue(Variable, Value);
#else
	const auto Priority = static_cast<EConsoleVariableFlags>(Variable->GetFlags() & ECVF_SetByMask);
	if (IsArrayPriority(Priority))
		ReleaseScreenshotWarmupValue(Variable, Variable->GetFlags());
	else
		Variable->Set(Value, Priority);
#endif
}
}
