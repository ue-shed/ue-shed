#include "CameraPreviewShelf.h"
#include "Serialization/JsonSerializer.h"

FString FCameraPreviewShelf::Key(const TSharedPtr<FJsonObject> &Panel, const FString &CameraId)
{
    if (!Panel)
        return {};
    auto Inputs = MakeShared<FJsonObject>();
    const TArray<TSharedPtr<FJsonValue>> *Cameras = nullptr;
    if (Panel->TryGetArrayField(TEXT("cameras"), Cameras))
        for (const auto &Value : *Cameras)
        {
            const auto Camera = Value->AsObject();
            FString Id;
            if (!Camera || !Camera->TryGetStringField(TEXT("id"), Id) || Id != CameraId)
                continue;
            // Saving a view changes "approved" but not the image.
            if (const auto Pose = Camera->Values.Find(TEXT("pose")))
                Inputs->SetField(TEXT("pose"), *Pose);
            if (const auto Visibility = Camera->Values.Find(TEXT("visibility")))
                Inputs->SetField(TEXT("visibility"), *Visibility);
        }
    if (const auto Policy = Panel->Values.Find(TEXT("renderPolicy")))
        Inputs->SetField(TEXT("renderPolicy"), *Policy);
    const TSharedPtr<FJsonObject> *Arrangement = nullptr;
    if (Panel->TryGetObjectField(TEXT("arrangement"), Arrangement))
        for (const TCHAR *Field : {TEXT("output"), TEXT("subject")})
            if (const auto Value = (*Arrangement)->Values.Find(Field))
                Inputs->SetField(Field, *Value);
    FString Text;
    FJsonSerializer::Serialize(Inputs, TJsonWriterFactory<>::Create(&Text));
    return Text;
}
