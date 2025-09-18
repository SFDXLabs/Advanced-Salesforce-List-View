public with sharing class CustomListViewController {
  @AuraEnabled(cacheable=true)
  public static List<SObject> getRecords(
    String objectName,
    String fields,
    String whereClause,
    Integer limitClause,
    Integer offsetClause,
    String orderBy
  ) {
    try {
      if (String.isBlank(objectName) || String.isBlank(fields)) {
        throw new AuraHandledException('Object name and fields are required');
      }

      if (limitClause != null && (limitClause <= 0 || limitClause > 2000)) {
        throw new AuraHandledException('Limit must be between 1 and 2000');
      }
      if (offsetClause != null && offsetClause < 0) {
        throw new AuraHandledException('Offset must be non-negative');
      }

      // Validate object/fields and orderBy tokens
      validateAccess(objectName, fields);
      String safeOrderBy = buildSafeOrderBy(objectName, orderBy);

      // Build SOQL
      // NOTE: Do not escape identifiers; we validated them.
      String soql = 'SELECT Id, ' + fields + ' FROM ' + objectName;

      if (String.isNotBlank(whereClause)) {
        // whereClause is constructed in LWC from controlled values and escaped for literals
        soql += ' WHERE ' + whereClause;
      }

      if (String.isNotBlank(safeOrderBy)) {
        soql += ' ORDER BY ' + safeOrderBy;
      } else {
        soql += ' ORDER BY CreatedDate DESC NULLS LAST';
      }

      if (limitClause != null && limitClause > 0) {
        soql += ' LIMIT ' + limitClause;
      }
      if (offsetClause != null && offsetClause >= 0) {
        soql += ' OFFSET ' + offsetClause;
      }

      System.debug('Executing SOQL: ' + soql);
      return Database.query(soql);

    } catch (QueryException e) {
      System.debug('Query Exception: ' + e.getMessage());
      throw new AuraHandledException('Query error: ' + e.getMessage());
    } catch (Exception e) {
      System.debug('General Exception: ' + e.getMessage());
      throw new AuraHandledException('Error querying records: ' + e.getMessage());
    }
  }

  @AuraEnabled(cacheable=true)
  public static Integer getRecordCount(String objectName, String whereClause) {
    try {
      if (String.isBlank(objectName)) {
        throw new AuraHandledException('Object name is required');
      }

      Schema.DescribeSObjectResult objectDescribe = getObjectDescribe(objectName);
      if (objectDescribe == null || !objectDescribe.isAccessible()) {
        throw new AuraHandledException('No access to object: ' + objectName);
      }

      String soql = 'SELECT COUNT() FROM ' + objectName;

      if (String.isNotBlank(whereClause)) {
        soql += ' WHERE ' + whereClause;
      }

      System.debug('Executing count SOQL: ' + soql);
      return Database.countQuery(soql);

    } catch (QueryException e) {
      System.debug('Count Query Exception: ' + e.getMessage());
      throw new AuraHandledException('Count query error: ' + e.getMessage());
    } catch (Exception e) {
      System.debug('Count General Exception: ' + e.getMessage());
      throw new AuraHandledException('Error counting records: ' + e.getMessage());
    }
  }

  @AuraEnabled(cacheable=true)
  public static Map<String, Object> getObjectFieldInfo(String objectName) {
    try {
      if (String.isBlank(objectName)) {
        throw new AuraHandledException('Object name is required');
      }

      Schema.DescribeSObjectResult objectDescribe = getObjectDescribe(objectName);
      if (objectDescribe == null || !objectDescribe.isAccessible()) {
        throw new AuraHandledException('No access to object: ' + objectName);
      }

      Map<String, Object> result = new Map<String, Object>();
      Map<String, Schema.SObjectField> fieldMap = objectDescribe.fields.getMap();
      Map<String, Object> fields = new Map<String, Object>();

      for (String fieldName : fieldMap.keySet()) {
        Schema.DescribeFieldResult fieldDescribe = fieldMap.get(fieldName).getDescribe();
        if (fieldDescribe.isAccessible()) {
          Map<String, Object> fieldInfo = new Map<String, Object>();
          fieldInfo.put('label', fieldDescribe.getLabel());
          fieldInfo.put('type', String.valueOf(fieldDescribe.getType()));
          fieldInfo.put('required', fieldDescribe.isNillable() == false && fieldDescribe.isDefaultedOnCreate() == false);
          fieldInfo.put('updateable', fieldDescribe.isUpdateable());
          fieldInfo.put('sortable', fieldDescribe.isSortable());
          fields.put(fieldName, fieldInfo);
        }
      }

      result.put('fields', fields);
      result.put('label', objectDescribe.getLabel());
      result.put('labelPlural', objectDescribe.getLabelPlural());

      return result;

    } catch (Exception e) {
      throw new AuraHandledException('Error getting object field info: ' + e.getMessage());
    }
  }

  private static void validateAccess(String objectName, String fields) {
    Schema.DescribeSObjectResult objectDescribe = getObjectDescribe(objectName);

    if (objectDescribe == null || !objectDescribe.isAccessible()) {
      throw new AuraHandledException('No access to object: ' + objectName);
    }

    Map<String, Schema.SObjectField> fieldMap = objectDescribe.fields.getMap();
    List<String> fieldList = fields.split(',');
    for (String field : fieldList) {
      String trimmedField = field.trim();
      // Use exact key check first, then case-insensitive fallback
      Schema.SObjectField sf = fieldMap.get(trimmedField);
      if (sf == null) {
        // Fallback to case-insensitive match
        sf = fieldMap.get(trimmedField.toLowerCase());
      }
      if (sf == null) {
        throw new AuraHandledException('Unknown field: ' + trimmedField);
      }
      Schema.DescribeFieldResult d = sf.getDescribe();
      if (!d.isAccessible()) {
        throw new AuraHandledException('No access to field: ' + trimmedField);
      }
    }
  }

  private static String buildSafeOrderBy(String objectName, String orderBy) {
    if (String.isBlank(orderBy)) return null;
    // Allow patterns like "FieldName ASC|DESC" or multiple fields separated by commas
    // Validate each field is real and sortable
    Schema.DescribeSObjectResult dor = getObjectDescribe(objectName);
    if (dor == null) return null;
    Map<String, Schema.SObjectField> fieldMap = dor.fields.getMap();

    List<String> parts = new List<String>();
    for (String seg : orderBy.split(',')) {
      String s = seg.trim();
      if (s == '') continue;
      List<String> tokens = s.split('\\s+');
      String fieldName = tokens[0];
      String dir = (tokens.size() > 1) ? tokens[1].toUpperCase() : 'ASC';

      Schema.SObjectField sf = fieldMap.get(fieldName);
      if (sf == null) {
        // Try case-insensitive fallback
        sf = fieldMap.get(fieldName != null ? fieldName.toLowerCase() : null);
      }
      if (sf == null) continue; // skip unknown fields

      Schema.DescribeFieldResult fd = sf.getDescribe();
      if (!fd.isSortable()) continue; // skip unsortable

      if (dir != 'ASC' && dir != 'DESC') dir = 'ASC';
      parts.add(fieldName + ' ' + dir);
    }
    return parts.isEmpty() ? null : String.join(parts, ', ');
  }

  private static Schema.DescribeSObjectResult getObjectDescribe(String objectName) {
    try {
      return Schema.getGlobalDescribe().get(objectName)?.getDescribe();
    } catch (Exception e) {
      return null;
    }
  }

  @AuraEnabled
  public static String validateSOQL(String soql) {
    try {
      Database.query(soql + ' LIMIT 1');
      return 'Valid';
    } catch (Exception e) {
      return 'Invalid: ' + e.getMessage();
    }
  }
}