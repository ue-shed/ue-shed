#pragma once
#include "Dom/JsonObject.h"
#include "GameFramework/Actor.h"
#include "Engine/Level.h"

inline void AddUEShedActorMetadata(const TSharedRef<FJsonObject>& Record, const AActor* Actor)
{
 if (!Actor) return;
 Record->SetStringField(TEXT("classPath"), Actor->GetClass()->GetPathName());
 if (Actor->GetActorGuid().IsValid()) Record->SetStringField(TEXT("actorGuid"), Actor->GetActorGuid().ToString(EGuidFormats::Digits));
 Record->SetStringField(TEXT("folderPath"), Actor->GetFolderPath().IsNone() ? FString() : Actor->GetFolderPath().ToString());
 Record->SetStringField(TEXT("levelPackage"), Actor->GetLevel()->GetOutermost()->GetName());
 TArray<TSharedPtr<FJsonValue>> Tags;
 for (const FName& Tag : Actor->Tags) { if (Tags.Num() == 256) break; Tags.Add(MakeShared<FJsonValueString>(Tag.ToString())); }
 Record->SetArrayField(TEXT("tags"), Tags);
 Record->SetBoolField(TEXT("tagsTruncated"), Actor->Tags.Num() > 256);
}
