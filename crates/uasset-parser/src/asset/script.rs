//! Compiled Blueprint functions: the text literals their saved script bytecode holds.
//!
//! Unreal's gather reads a Blueprint function's `EX_TextConst` literals from its bytecode
//! (`FPropertyLocalizationDataGatherer::GatherScriptBytecode`, UE 5.7 and 5.8). The walk below
//! follows `SerializeExpr` (`ScriptSerialization.h`, UE 4.27 and 5.7; `ScriptSerialization.inl`,
//! UE 5.8) as a linker writes it: object references are `FPackageIndex`es, names are an index
//! and a number, and property references are `FFieldPath`s (`FPropertyProxyArchive`). The script
//! must consume exactly its saved storage size and end in `EX_EndOfScript`.

use super::*;
use crate::property::{TextHistory, TextValue};

/// Exact serialized class path of `UFunction` exports.
pub const FUNCTION_CLASS: &str = "/Script/CoreUObject.Function";

/// `FReleaseObjectVersion` and `FFortniteMainBranchObjectVersion` keys and the
/// `FFieldPathOwnerSerialization` entries after which an `FFieldPath` saves its owner.
const RELEASE_OBJECT_VERSION: Guid = Guid {
    a: 0x9C54_D522,
    b: 0xA826_4FBE,
    c: 0x9421_0746,
    d: 0x61B4_82D0,
};
const RELEASE_FIELD_PATH_OWNER: i32 = 30;
const FORTNITE_MAIN_VERSION: Guid = Guid {
    a: 0x601D_1886,
    b: 0xAC64_4F84,
    c: 0xAA16_D3DE,
    d: 0x0DEA_C7D6,
};
const FORTNITE_MAIN_FIELD_PATH_OWNER: i32 = 33;
const UE4_CHANGE_SETARRAY_BYTECODE: i32 = 303;
const UE4_SERIALIZE_BLUEPRINT_EVENTGRAPH_FASTCALLS_IN_UFUNCTION: i32 = 451;
const UE5_LARGE_WORLD_COORDINATES: i32 = 1004;
const FUNC_NET: u32 = 0x0000_0040;
/// Bytecode expressions nest; a malformed script must not exhaust the stack.
const MAX_EXPRESSION_DEPTH: usize = 512;
/// An `FFieldPath` names a property inside its owner struct; real paths are a few names long.
const MAX_FIELD_PATH_NAMES: i32 = 64;

/// A `UFunction` export: the generic object view every other consumer reads, and the text
/// literals of its saved script.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedFunction {
    /// The export as [`UObjectDecoder`] reads it; `tail` still spans the UStruct body.
    pub object: DecodedUObject,
    /// Each non-empty `EX_TextConst` literal, in bytecode order.
    pub script_texts: Vec<TextValue>,
}

pub struct FunctionDecoder;

impl AssetDecoder for FunctionDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        class_path.as_str() == FUNCTION_CLASS
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        if !export
            .class_path
            .as_ref()
            .is_some_and(|class| self.supports(class))
        {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} is not a UFunction", export.object_path),
            ));
        }
        let DecodedAsset::UObject(object) = UObjectDecoder.decode(export, context)? else {
            unreachable!("UObjectDecoder only returns UObject");
        };
        let path = &export.object_path;
        let mut reader = context
            .package
            .export_reader(context.source, export)?
            .bounded(object.tail, &format!("{path}.UStruct"))?;
        // The generic tail starts at UObject::Serialize's object GUID flag, as a struct's does.
        let footer_offset = reader.tell();
        let footer = reader.read_i32(&format!("{path}.ExportFooter"))?;
        if footer != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "expected zero function UObject footer at byte {footer_offset}, got {footer}"
                ),
            ));
        }
        decode_struct_members(&mut reader, context, path)?;
        let _bytecode_size = reader.read_i32(&format!("{path}.ScriptBytecodeSize"))?;
        let storage_offset = reader.tell();
        let storage_size = reader.read_i32(&format!("{path}.ScriptStorageSize"))?;
        let storage_size = u64::try_from(storage_size).map_err(|_| {
            AssetError::new(
                AssetErrorKind::MalformedData,
                format!("negative script storage size {storage_size} at byte {storage_offset}"),
            )
        })?;
        let script = reader.take_bounded(storage_size, &format!("{path}.Script"))?;
        let script_texts = ScriptWalk::new(script, context, path.as_str()).texts()?;

        // UFunction::Serialize after UStruct: flags, the unused replication offset of network
        // functions, then the event graph fast-call target.
        let flags = reader.read_u32(&format!("{path}.FunctionFlags"))?;
        if flags & FUNC_NET != 0 {
            reader.read_i16(&format!("{path}.RepOffset"))?;
        }
        if context
            .package
            .summary
            .versions
            .is_at_least_ue4(UE4_SERIALIZE_BLUEPRINT_EVENTGRAPH_FASTCALLS_IN_UFUNCTION)
        {
            reader.read_i32(&format!("{path}.EventGraphFunction"))?;
            reader.read_i32(&format!("{path}.EventGraphCallOffset"))?;
        }
        if reader.remaining() != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "function export {path} left {} trailing bytes",
                    reader.remaining()
                ),
            ));
        }
        Ok(DecodedAsset::Function(DecodedFunction {
            object,
            script_texts,
        }))
    }
}

mod token {
    pub const LOCAL_VARIABLE: u8 = 0x00;
    pub const INSTANCE_VARIABLE: u8 = 0x01;
    pub const DEFAULT_VARIABLE: u8 = 0x02;
    pub const RETURN: u8 = 0x04;
    pub const JUMP: u8 = 0x06;
    pub const JUMP_IF_NOT: u8 = 0x07;
    pub const ASSERT: u8 = 0x09;
    pub const NOTHING: u8 = 0x0B;
    pub const NOTHING_INT32: u8 = 0x0C;
    pub const LET: u8 = 0x0F;
    pub const BIT_FIELD_CONST: u8 = 0x11;
    pub const CLASS_CONTEXT: u8 = 0x12;
    pub const META_CAST: u8 = 0x13;
    pub const LET_BOOL: u8 = 0x14;
    pub const END_PARM_VALUE: u8 = 0x15;
    pub const END_FUNCTION_PARMS: u8 = 0x16;
    pub const SELF: u8 = 0x17;
    pub const SKIP: u8 = 0x18;
    pub const CONTEXT: u8 = 0x19;
    pub const CONTEXT_FAIL_SILENT: u8 = 0x1A;
    pub const VIRTUAL_FUNCTION: u8 = 0x1B;
    pub const FINAL_FUNCTION: u8 = 0x1C;
    pub const INT_CONST: u8 = 0x1D;
    pub const FLOAT_CONST: u8 = 0x1E;
    pub const STRING_CONST: u8 = 0x1F;
    pub const OBJECT_CONST: u8 = 0x20;
    pub const NAME_CONST: u8 = 0x21;
    pub const ROTATION_CONST: u8 = 0x22;
    pub const VECTOR_CONST: u8 = 0x23;
    pub const BYTE_CONST: u8 = 0x24;
    pub const INT_ZERO: u8 = 0x25;
    pub const INT_ONE: u8 = 0x26;
    pub const TRUE: u8 = 0x27;
    pub const FALSE: u8 = 0x28;
    pub const TEXT_CONST: u8 = 0x29;
    pub const NO_OBJECT: u8 = 0x2A;
    pub const TRANSFORM_CONST: u8 = 0x2B;
    pub const INT_CONST_BYTE: u8 = 0x2C;
    pub const NO_INTERFACE: u8 = 0x2D;
    pub const DYNAMIC_CAST: u8 = 0x2E;
    pub const STRUCT_CONST: u8 = 0x2F;
    pub const END_STRUCT_CONST: u8 = 0x30;
    pub const SET_ARRAY: u8 = 0x31;
    pub const END_ARRAY: u8 = 0x32;
    pub const PROPERTY_CONST: u8 = 0x33;
    pub const UNICODE_STRING_CONST: u8 = 0x34;
    pub const INT64_CONST: u8 = 0x35;
    pub const UINT64_CONST: u8 = 0x36;
    pub const DOUBLE_CONST: u8 = 0x37;
    /// `EX_Cast`; `EX_PrimitiveCast` in UE 4.27, with the same payload.
    pub const CAST: u8 = 0x38;
    pub const SET_SET: u8 = 0x39;
    pub const END_SET: u8 = 0x3A;
    pub const SET_MAP: u8 = 0x3B;
    pub const END_MAP: u8 = 0x3C;
    pub const SET_CONST: u8 = 0x3D;
    pub const END_SET_CONST: u8 = 0x3E;
    pub const MAP_CONST: u8 = 0x3F;
    pub const END_MAP_CONST: u8 = 0x40;
    pub const VECTOR3F_CONST: u8 = 0x41;
    pub const STRUCT_MEMBER_CONTEXT: u8 = 0x42;
    pub const LET_MULTICAST_DELEGATE: u8 = 0x43;
    pub const LET_DELEGATE: u8 = 0x44;
    pub const LOCAL_VIRTUAL_FUNCTION: u8 = 0x45;
    pub const LOCAL_FINAL_FUNCTION: u8 = 0x46;
    pub const LOCAL_OUT_VARIABLE: u8 = 0x48;
    pub const DEPRECATED_OP_4A: u8 = 0x4A;
    pub const INSTANCE_DELEGATE: u8 = 0x4B;
    pub const PUSH_EXECUTION_FLOW: u8 = 0x4C;
    pub const POP_EXECUTION_FLOW: u8 = 0x4D;
    pub const COMPUTED_JUMP: u8 = 0x4E;
    pub const POP_EXECUTION_FLOW_IF_NOT: u8 = 0x4F;
    pub const BREAKPOINT: u8 = 0x50;
    pub const INTERFACE_CONTEXT: u8 = 0x51;
    pub const OBJ_TO_INTERFACE_CAST: u8 = 0x52;
    pub const END_OF_SCRIPT: u8 = 0x53;
    pub const CROSS_INTERFACE_CAST: u8 = 0x54;
    pub const INTERFACE_TO_OBJ_CAST: u8 = 0x55;
    pub const WIRE_TRACEPOINT: u8 = 0x5A;
    pub const SKIP_OFFSET_CONST: u8 = 0x5B;
    pub const ADD_MULTICAST_DELEGATE: u8 = 0x5C;
    pub const CLEAR_MULTICAST_DELEGATE: u8 = 0x5D;
    pub const TRACEPOINT: u8 = 0x5E;
    pub const LET_OBJ: u8 = 0x5F;
    pub const LET_WEAK_OBJ_PTR: u8 = 0x60;
    pub const BIND_DELEGATE: u8 = 0x61;
    pub const REMOVE_MULTICAST_DELEGATE: u8 = 0x62;
    pub const CALL_MULTICAST_DELEGATE: u8 = 0x63;
    pub const LET_VALUE_ON_PERSISTENT_FRAME: u8 = 0x64;
    pub const ARRAY_CONST: u8 = 0x65;
    pub const END_ARRAY_CONST: u8 = 0x66;
    pub const SOFT_OBJECT_CONST: u8 = 0x67;
    pub const CALL_MATH: u8 = 0x68;
    pub const SWITCH_VALUE: u8 = 0x69;
    pub const ARRAY_GET_BY_REF: u8 = 0x6B;
    pub const CLASS_SPARSE_DATA_VARIABLE: u8 = 0x6C;
    pub const FIELD_PATH_CONST: u8 = 0x6D;
    pub const AUTO_RTFM_TRANSACT: u8 = 0x70;
    pub const AUTO_RTFM_STOP_TRANSACT: u8 = 0x71;
    pub const AUTO_RTFM_ABORT_IF_NOT: u8 = 0x72;
    /// UE 5.8.
    pub const AUTO_RTFM_ABORT: u8 = 0x73;
}

/// `EBlueprintTextLiteralType`, as `XFERTEXT` reads the saved byte.
///
/// UE 5.8 inserted `LocalizedTextWithNotes` at 2 (`Script.h`), moving the later types up by one.
/// The bytecode carries no version of its own; the change shipped with FText translator notes,
/// FortniteMain `AddDevNotesToFText` (260), which is the only saved marker for it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TextLiteral {
    Empty,
    Localized,
    LocalizedWithNotes,
    Invariant,
    LiteralString,
    StringTableEntry,
}

impl TextLiteral {
    fn from_saved(byte: u8, notes_layout: bool) -> Option<Self> {
        Some(match (byte, notes_layout) {
            (0, _) => Self::Empty,
            (1, _) => Self::Localized,
            (2, true) => Self::LocalizedWithNotes,
            (2, false) | (3, true) => Self::Invariant,
            (3, false) | (4, true) => Self::LiteralString,
            (4, false) | (5, true) => Self::StringTableEntry,
            _ => return None,
        })
    }
}

/// FortniteMain `AddDevNotesToFText`, from which saved text literals use the UE 5.8 numbering.
const FORTNITE_MAIN_TEXT_DEV_NOTES: i32 = 260;

struct ScriptWalk<'r, 'a> {
    reader: crate::archive::Reader<'r>,
    context: &'a AssetDecodeContext<'a>,
    path: &'a str,
    large_world_coordinates: bool,
    field_path_owner: bool,
    text_literal_notes_layout: bool,
    texts: Vec<TextValue>,
}

impl<'r, 'a> ScriptWalk<'r, 'a> {
    fn new(
        reader: crate::archive::Reader<'r>,
        context: &'a AssetDecodeContext<'a>,
        path: &'a str,
    ) -> Self {
        let summary = &context.package.summary;
        let version = |key: Guid| {
            summary
                .custom_versions
                .iter()
                .find(|version| version.key == key)
                .map_or(-1, |version| version.version)
        };
        Self {
            reader,
            context,
            path,
            large_world_coordinates: summary
                .versions
                .is_at_least_ue5(UE5_LARGE_WORLD_COORDINATES),
            field_path_owner: version(RELEASE_OBJECT_VERSION) >= RELEASE_FIELD_PATH_OWNER
                || version(FORTNITE_MAIN_VERSION) >= FORTNITE_MAIN_FIELD_PATH_OWNER,
            text_literal_notes_layout: version(FORTNITE_MAIN_VERSION)
                >= FORTNITE_MAIN_TEXT_DEV_NOTES,
            texts: Vec::new(),
        }
    }

    fn texts(mut self) -> Result<Vec<TextValue>, AssetError> {
        let mut last = None;
        while self.reader.remaining() != 0 {
            last = Some(self.expression(0)?);
        }
        if last.is_some_and(|last| last != token::END_OF_SCRIPT) {
            return Err(self.malformed("script does not end in EX_EndOfScript"));
        }
        Ok(self.texts)
    }

    fn malformed(&self, message: impl std::fmt::Display) -> AssetError {
        AssetError::new(
            AssetErrorKind::MalformedData,
            format!(
                "{}.Script at byte {}: {message}",
                self.path,
                self.reader.tell()
            ),
        )
    }

    fn at(&self) -> String {
        format!("{}.Script@{}", self.path, self.reader.tell())
    }

    fn skip(&mut self, bytes: u64) -> Result<(), AssetError> {
        let at = self.at();
        self.reader.skip(bytes, &at).map_err(Into::into)
    }

    fn read_u8(&mut self) -> Result<u8, AssetError> {
        let at = self.at();
        self.reader.read_u8(&at).map_err(Into::into)
    }

    fn read_i32(&mut self) -> Result<i32, AssetError> {
        let at = self.at();
        self.reader.read_i32(&at).map_err(Into::into)
    }

    fn read_u16(&mut self) -> Result<u16, AssetError> {
        let at = self.at();
        self.reader.read_u16(&at).map_err(Into::into)
    }

    /// `CodeSkipSizeType`: a `uint32` unless the engine limits bytecode to 64 KB (it does not).
    fn skip_offset(&mut self) -> Result<(), AssetError> {
        self.skip(4)
    }

    /// A `UObject*` (or `TObjectPtr`, `UStruct*`, `UClass*`) reference: an `FPackageIndex`.
    fn object(&mut self) -> Result<i32, AssetError> {
        self.read_i32()
    }

    fn name(&mut self) -> Result<(), AssetError> {
        let at = self.at();
        self.reader.read_name_ref(&at)?;
        Ok(())
    }

    /// An `FField*` (`FProperty*`) saved through `FPropertyProxyArchive` as an `FFieldPath`.
    fn field(&mut self) -> Result<(), AssetError> {
        let count = self.read_i32()?;
        if !(0..=MAX_FIELD_PATH_NAMES).contains(&count) {
            return Err(self.malformed(format!("field path has {count} names")));
        }
        for _ in 0..count {
            self.name()?;
        }
        if self.field_path_owner {
            self.object()?;
        }
        Ok(())
    }

    fn until(&mut self, depth: usize, end: u8) -> Result<(), AssetError> {
        while self.expression(depth + 1)? != end {}
        Ok(())
    }

    /// One `SerializeExpr`, returning its token.
    fn expression(&mut self, depth: usize) -> Result<u8, AssetError> {
        if depth >= MAX_EXPRESSION_DEPTH {
            return Err(self.malformed(format!(
                "expressions nest deeper than {MAX_EXPRESSION_DEPTH}"
            )));
        }
        let next = depth + 1;
        let expression = self.read_u8()?;
        match expression {
            token::CAST => {
                self.read_u8()?;
                self.expression(next)?;
            }
            token::OBJ_TO_INTERFACE_CAST
            | token::CROSS_INTERFACE_CAST
            | token::INTERFACE_TO_OBJ_CAST
            | token::META_CAST
            | token::DYNAMIC_CAST => {
                self.object()?;
                self.expression(next)?;
            }
            token::LET => {
                self.field()?;
                self.expression(next)?;
                self.expression(next)?;
            }
            token::LET_OBJ
            | token::LET_WEAK_OBJ_PTR
            | token::LET_BOOL
            | token::LET_DELEGATE
            | token::LET_MULTICAST_DELEGATE
            | token::ADD_MULTICAST_DELEGATE
            | token::REMOVE_MULTICAST_DELEGATE
            | token::ARRAY_GET_BY_REF => {
                self.expression(next)?;
                self.expression(next)?;
            }
            token::LET_VALUE_ON_PERSISTENT_FRAME | token::STRUCT_MEMBER_CONTEXT => {
                self.field()?;
                self.expression(next)?;
            }
            token::JUMP | token::PUSH_EXECUTION_FLOW | token::SKIP_OFFSET_CONST => {
                self.skip_offset()?;
            }
            token::COMPUTED_JUMP
            | token::INTERFACE_CONTEXT
            | token::RETURN
            | token::CLEAR_MULTICAST_DELEGATE
            | token::SOFT_OBJECT_CONST
            | token::FIELD_PATH_CONST
            | token::POP_EXECUTION_FLOW_IF_NOT
            | token::AUTO_RTFM_ABORT_IF_NOT => {
                self.expression(next)?;
            }
            token::LOCAL_VARIABLE
            | token::INSTANCE_VARIABLE
            | token::DEFAULT_VARIABLE
            | token::LOCAL_OUT_VARIABLE
            | token::CLASS_SPARSE_DATA_VARIABLE
            | token::PROPERTY_CONST => self.field()?,
            token::NOTHING_INT32 | token::INT_CONST => self.skip(4)?,
            token::NOTHING
            | token::END_OF_SCRIPT
            | token::END_FUNCTION_PARMS
            | token::END_STRUCT_CONST
            | token::END_ARRAY
            | token::END_ARRAY_CONST
            | token::END_SET
            | token::END_MAP
            | token::END_SET_CONST
            | token::END_MAP_CONST
            | token::INT_ZERO
            | token::INT_ONE
            | token::TRUE
            | token::FALSE
            | token::NO_OBJECT
            | token::NO_INTERFACE
            | token::SELF
            | token::END_PARM_VALUE
            | token::POP_EXECUTION_FLOW
            | token::DEPRECATED_OP_4A
            | token::WIRE_TRACEPOINT
            | token::TRACEPOINT
            | token::BREAKPOINT
            | token::AUTO_RTFM_ABORT => {}
            token::CALL_MATH
            | token::LOCAL_FINAL_FUNCTION
            | token::FINAL_FUNCTION
            | token::CALL_MULTICAST_DELEGATE => {
                self.object()?;
                self.until(depth, token::END_FUNCTION_PARMS)?;
            }
            token::LOCAL_VIRTUAL_FUNCTION | token::VIRTUAL_FUNCTION => {
                self.name()?;
                self.until(depth, token::END_FUNCTION_PARMS)?;
            }
            token::CLASS_CONTEXT | token::CONTEXT | token::CONTEXT_FAIL_SILENT => {
                self.expression(next)?;
                self.skip_offset()?;
                self.field()?;
                self.expression(next)?;
            }
            token::INT64_CONST | token::UINT64_CONST | token::DOUBLE_CONST => self.skip(8)?,
            token::FLOAT_CONST => self.skip(4)?,
            token::STRING_CONST | token::UNICODE_STRING_CONST => {
                self.string_after(expression)?;
            }
            token::TEXT_CONST => self.text()?,
            token::OBJECT_CONST => {
                self.object()?;
            }
            token::NAME_CONST | token::INSTANCE_DELEGATE => self.name()?,
            token::ROTATION_CONST | token::VECTOR_CONST => {
                self.skip(if self.large_world_coordinates { 24 } else { 12 })?;
            }
            token::VECTOR3F_CONST => self.skip(12)?,
            token::TRANSFORM_CONST => {
                self.skip(if self.large_world_coordinates { 80 } else { 40 })?;
            }
            token::STRUCT_CONST => {
                self.object()?;
                self.skip(4)?;
                self.until(depth, token::END_STRUCT_CONST)?;
            }
            token::SET_ARRAY => {
                if self
                    .context
                    .package
                    .summary
                    .versions
                    .is_at_least_ue4(UE4_CHANGE_SETARRAY_BYTECODE)
                {
                    self.expression(next)?;
                } else {
                    self.field()?;
                }
                self.until(depth, token::END_ARRAY)?;
            }
            token::SET_SET => {
                self.expression(next)?;
                self.skip(4)?;
                self.until(depth, token::END_SET)?;
            }
            token::SET_MAP => {
                self.expression(next)?;
                self.skip(4)?;
                self.until(depth, token::END_MAP)?;
            }
            token::ARRAY_CONST => {
                self.field()?;
                self.skip(4)?;
                self.until(depth, token::END_ARRAY_CONST)?;
            }
            token::SET_CONST => {
                self.field()?;
                self.skip(4)?;
                self.until(depth, token::END_SET_CONST)?;
            }
            token::MAP_CONST => {
                self.field()?;
                self.field()?;
                self.skip(4)?;
                self.until(depth, token::END_MAP_CONST)?;
            }
            token::BIT_FIELD_CONST => {
                self.field()?;
                self.skip(1)?;
            }
            token::BYTE_CONST | token::INT_CONST_BYTE => self.skip(1)?,
            token::JUMP_IF_NOT | token::SKIP => {
                self.skip_offset()?;
                self.expression(next)?;
            }
            token::ASSERT => {
                self.skip(3)?;
                self.expression(next)?;
            }
            token::BIND_DELEGATE => {
                self.name()?;
                self.expression(next)?;
                self.expression(next)?;
            }
            token::SWITCH_VALUE => {
                let cases = self.read_u16()?;
                self.skip_offset()?;
                self.expression(next)?;
                for _ in 0..cases {
                    self.expression(next)?;
                    self.skip_offset()?;
                    self.expression(next)?;
                }
                self.expression(next)?;
            }
            token::AUTO_RTFM_TRANSACT => {
                self.skip(4)?;
                self.skip_offset()?;
                self.until(depth, token::AUTO_RTFM_STOP_TRANSACT)?;
            }
            token::AUTO_RTFM_STOP_TRANSACT => self.skip(5)?,
            // EX_InstrumentationEvent (0x6A) only exists in instrumented builds, and its payload is
            // not written through the archive.
            other => {
                return Err(AssetError::new(
                    AssetErrorKind::UnsupportedCapability,
                    format!(
                        "{}.Script at byte {}: unsupported bytecode 0x{other:02X}",
                        self.path,
                        self.reader.tell() - 1
                    ),
                ));
            }
        }
        Ok(expression)
    }

    /// The null-terminated payload of `EX_StringConst` (8-bit code units) or
    /// `EX_UnicodeStringConst` (UTF-16).
    fn string_after(&mut self, expression: u8) -> Result<String, AssetError> {
        if expression == token::STRING_CONST {
            let mut text = String::new();
            loop {
                match self.read_u8()? {
                    0 => return Ok(text),
                    byte => text.push(char::from(byte)),
                }
            }
        }
        let mut units = Vec::new();
        loop {
            match self.read_u16()? {
                0 => break,
                unit => units.push(unit),
            }
        }
        String::from_utf16(&units).map_err(|error| {
            self.malformed(format!(
                "unicode string constant is invalid UTF-16: {error}"
            ))
        })
    }

    /// A text literal's string operand. The compiler always emits these as string constants
    /// (`FScriptBuilderBase::EmitStringLiteral`).
    fn string(&mut self) -> Result<String, AssetError> {
        let expression = self.read_u8()?;
        if expression != token::STRING_CONST && expression != token::UNICODE_STRING_CONST {
            return Err(self.malformed(format!(
                "text literal operand is bytecode 0x{expression:02X}, not a string constant"
            )));
        }
        self.string_after(expression)
    }

    /// `XFERTEXT`, recording the literal Unreal's gather sees.
    fn text(&mut self) -> Result<(), AssetError> {
        let saved = self.read_u8()?;
        let Some(literal) = TextLiteral::from_saved(saved, self.text_literal_notes_layout) else {
            return Err(self.malformed(format!("unknown text literal type {saved}")));
        };
        match literal {
            TextLiteral::Empty => {}
            TextLiteral::Localized | TextLiteral::LocalizedWithNotes => {
                let source = self.string()?;
                let key = self.string()?;
                let namespace = self.string()?;
                let dev_notes = if literal == TextLiteral::LocalizedWithNotes {
                    self.string()?
                } else {
                    String::new()
                };
                self.texts.push(TextValue {
                    source,
                    history: TextHistory::Base {
                        namespace,
                        key,
                        dev_notes,
                    },
                });
            }
            TextLiteral::Invariant | TextLiteral::LiteralString => {
                let source = self.string()?;
                self.texts.push(TextValue {
                    source,
                    history: TextHistory::None,
                });
            }
            TextLiteral::StringTableEntry => {
                self.object()?;
                let table_id = self.string()?;
                let key = self.string()?;
                self.texts.push(TextValue {
                    source: String::new(),
                    history: TextHistory::StringTableEntry { table_id, key },
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::embedded_source_model;

    const SIGN: &[u8] = include_bytes!(
        "../../../../fixtures/unreal-project/Content/Fixture/GameTextActions/BP_ActionSign.uasset"
    );

    fn decode(name: &str) -> Result<DecodedFunction, AssetError> {
        let package = Package::parse(SIGN).expect("fixture parses");
        let export = package
            .exports
            .iter()
            .find(|export| export.object_path.as_str().ends_with(name))
            .expect("function export");
        let context = AssetDecodeContext {
            property_filter: None,
            source: SIGN,
            package: &package,
            schemas: embedded_source_model(),
        };
        match FunctionDecoder.decode(export, &context)? {
            DecodedAsset::Function(function) => Ok(function),
            other => panic!("expected a function, got {other:?}"),
        }
    }

    /// Walks a synthetic script under the fixture package's versions (UE 5.7: large world
    /// coordinates, field path owners).
    fn walk(script: &[u8]) -> Result<Vec<TextValue>, AssetError> {
        walk_saved_by(script, None)
    }

    /// Walks a synthetic script as if the package were saved with the given FortniteMain
    /// version (UE 5.7 saves 225, UE 5.8 saves 268).
    fn walk_saved_by(
        script: &[u8],
        fortnite_main: Option<i32>,
    ) -> Result<Vec<TextValue>, AssetError> {
        let mut package = Package::parse(SIGN).expect("fixture parses");
        if let Some(saved) = fortnite_main {
            let version = package
                .summary
                .custom_versions
                .iter_mut()
                .find(|version| version.key == FORTNITE_MAIN_VERSION)
                .expect("the fixture records FortniteMain");
            assert_eq!(version.version, 225, "the fixture is saved by UE 5.7");
            version.version = saved;
        }
        let context = AssetDecodeContext {
            property_filter: None,
            source: script,
            package: &package,
            schemas: embedded_source_model(),
        };
        let reader = crate::archive::Reader::new(script);
        ScriptWalk::new(reader, &context, "/Game/Test.Test_C:Function").texts()
    }

    fn string_const(script: &mut Vec<u8>, value: &str) {
        script.push(token::STRING_CONST);
        script.extend_from_slice(value.as_bytes());
        script.push(0);
    }

    /// An `EX_TextConst` with the raw saved literal byte and string operands.
    fn text_const(saved_literal: u8, operands: &[&str]) -> Vec<u8> {
        let mut bytes = vec![token::TEXT_CONST, saved_literal];
        for value in operands {
            string_const(&mut bytes, value);
        }
        bytes
    }

    fn localized(source: &str, key: &str, namespace: &str) -> Vec<u8> {
        text_const(1, &[source, key, namespace])
    }

    fn base(source: &str, namespace: &str, key: &str, dev_notes: &str) -> TextValue {
        TextValue {
            source: source.to_owned(),
            history: TextHistory::Base {
                namespace: namespace.to_owned(),
                key: key.to_owned(),
                dev_notes: dev_notes.to_owned(),
            },
        }
    }

    fn untracked(source: &str) -> TextValue {
        TextValue {
            source: source.to_owned(),
            history: TextHistory::None,
        }
    }

    fn string_table(table_id: &str, key: &str) -> TextValue {
        TextValue {
            source: String::new(),
            history: TextHistory::StringTableEntry {
                table_id: table_id.to_owned(),
                key: key.to_owned(),
            },
        }
    }

    #[test]
    fn reads_the_print_text_literals_of_the_ubergraph() {
        let function = decode(".ExecuteUbergraph_BP_ActionSign").expect("ubergraph decodes");
        let literals: Vec<_> = function
            .script_texts
            .iter()
            .map(|text| match &text.history {
                TextHistory::Base { namespace, key, .. } => {
                    (text.source.as_str(), namespace.as_str(), key.len())
                }
                other => panic!("expected a localized literal, got {other:?}"),
            })
            .collect();
        // The original and its pasted copy share one id; the retyped copy has its own. Unlike a
        // saved FText property, the compiled literal carries no package namespace marker.
        assert_eq!(
            literals,
            [
                ("The door is barred", "", 32),
                ("The door is locked", "", 32),
                ("The door is locked", "", 32),
            ]
        );
    }

    #[test]
    fn reads_a_stub_that_only_calls_the_ubergraph() {
        let function = decode(".ReceiveBeginPlay").expect("stub decodes");
        assert!(function.script_texts.is_empty());
        assert!(!function.object.object_path.as_str().is_empty());
    }

    /// Saved bytes as UE 5.7's `KismetCompilerVMBackend` writes them: Empty 0, Localized 1,
    /// Invariant 2, LiteralString 3, StringTableEntry 4.
    #[test]
    fn reads_every_text_literal_type_saved_by_ue_5_7() {
        for fortnite_main in [None, Some(259)] {
            let mut script = localized("Open", "Key", "[PKG]");
            script.extend([token::TEXT_CONST, 0]);
            script.extend([token::TEXT_CONST, 2, token::UNICODE_STRING_CONST]);
            for unit in "Ünïcode".encode_utf16().chain([0]) {
                script.extend(unit.to_le_bytes());
            }
            script.extend(text_const(3, &["Literal"]));
            script.extend([token::TEXT_CONST, 4]);
            script.extend(0_i32.to_le_bytes());
            string_const(&mut script, "ST_Menu");
            string_const(&mut script, "Resume");
            script.push(token::END_OF_SCRIPT);
            assert_eq!(
                walk_saved_by(&script, fortnite_main).expect("script walks"),
                [
                    base("Open", "[PKG]", "Key", ""),
                    untracked("Ünïcode"),
                    untracked("Literal"),
                    string_table("ST_Menu", "Resume"),
                ]
            );
        }
    }

    /// Saved bytes as UE 5.8 writes them (`Script.h`): LocalizedTextWithNotes is 2 and carries
    /// translator notes as a fourth string; Invariant 3, LiteralString 4, StringTableEntry 5.
    #[test]
    fn reads_every_text_literal_type_saved_by_ue_5_8() {
        let mut script = localized("Open", "Key", "");
        script.extend(text_const(
            2,
            &["Close", "Key2", "", "The window, not the app"],
        ));
        script.extend([token::TEXT_CONST, 0]);
        script.extend(text_const(3, &["Invariant"]));
        script.extend(text_const(4, &["Literal"]));
        script.extend([token::TEXT_CONST, 5]);
        script.extend(0_i32.to_le_bytes());
        string_const(&mut script, "ST_Menu");
        string_const(&mut script, "Resume");
        script.push(token::END_OF_SCRIPT);
        assert_eq!(
            walk_saved_by(&script, Some(268)).expect("script walks"),
            [
                base("Open", "", "Key", ""),
                base("Close", "", "Key2", "The window, not the app"),
                untracked("Invariant"),
                untracked("Literal"),
                string_table("ST_Menu", "Resume"),
            ]
        );

        let mut unknown = text_const(6, &[]);
        unknown.push(token::END_OF_SCRIPT);
        let unknown = walk_saved_by(&unknown, Some(268)).expect_err("no literal type 6");
        assert!(unknown.message().contains("unknown text literal type 6"));
        let mut before = text_const(5, &[]);
        before.push(token::END_OF_SCRIPT);
        let before = walk_saved_by(&before, Some(259)).expect_err("no literal type 5 before 5.8");
        assert!(before.message().contains("unknown text literal type 5"));
    }

    #[test]
    fn finds_text_inside_calls_contexts_and_switches() {
        // Context(Self) -> VirtualFunction "Name"(TextConst, EndFunctionParms), with an FFieldPath
        // (one name, an owner) as the r-value property, then a switch whose default is text.
        let mut script = vec![token::CONTEXT, token::SELF];
        script.extend(7_u32.to_le_bytes());
        script.extend(1_i32.to_le_bytes());
        script.extend([0; 8]);
        script.extend((-1_i32).to_le_bytes());
        script.push(token::VIRTUAL_FUNCTION);
        script.extend([0; 8]);
        script.extend(localized("Call", "A", ""));
        script.push(token::END_FUNCTION_PARMS);
        script.push(token::SWITCH_VALUE);
        script.extend(1_u16.to_le_bytes());
        script.extend(0_u32.to_le_bytes());
        script.push(token::INT_ZERO);
        script.push(token::INT_ZERO);
        script.extend(0_u32.to_le_bytes());
        script.extend(localized("Case", "B", ""));
        script.extend(localized("Default", "C", ""));
        script.push(token::VECTOR_CONST);
        script.extend([0; 24]);
        script.push(token::END_OF_SCRIPT);
        let sources: Vec<_> = walk(&script)
            .expect("script walks")
            .into_iter()
            .map(|text| text.source)
            .collect();
        assert_eq!(sources, ["Call", "Case", "Default"]);
    }

    #[test]
    fn rejects_what_it_cannot_follow() {
        let unknown = walk(&[0x0E, token::END_OF_SCRIPT]).expect_err("unused token");
        assert_eq!(unknown.kind(), AssetErrorKind::UnsupportedCapability);
        assert!(unknown.message().contains("unsupported bytecode 0x0E"));

        let unterminated = walk(&[token::NOTHING]).expect_err("no EX_EndOfScript");
        assert!(unterminated.message().contains("EX_EndOfScript"));

        let mut field = vec![token::LOCAL_VARIABLE];
        field.extend(i32::MAX.to_le_bytes());
        let field = walk(&field).expect_err("absurd field path");
        assert!(field.message().contains("field path has"));

        let mut operand = vec![token::TEXT_CONST, 2, token::INT_ZERO];
        operand.push(token::END_OF_SCRIPT);
        let operand = walk(&operand).expect_err("non-string operand");
        assert!(operand.message().contains("not a string constant"));

        let truncated = walk(&[token::INT_CONST, 0, 0]).expect_err("truncated operand");
        assert_eq!(truncated.kind(), AssetErrorKind::MalformedData);
    }
}
